"""Download coordinator for dragontree_reolink."""

from __future__ import annotations

import asyncio
import datetime as dt
import io
import json
import os
import re
from typing import Any

import aiofiles
from reolink_aio.enums import VodRequestType
from reolink_aio.typings import VOD_trigger

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util, slugify
from homeassistant.util.ssl import SSLCipherList

from aiohttp import ClientTimeout

from .const import (
    CONF_MAX_DISK_GB,
    CONF_STREAM,
    DB_PATH,
    DEFAULT_MAX_DISK_GB,
    DEFAULT_STREAM,
    DOMAIN,
    EVENT_QUEUE_CHANGED,
    EVENT_RECORD_TIMER_CHANGED,
    EVENT_RECORDING_ADDED,
    INIT_LOOKBACK_DAYS,
    INIT_RECORDINGS_PER_CAMERA,
    LOGGER,
    MANUAL_REC_TIMEOUT_SECS,
    MEDIA_BASE_DIR,
    MIN_RECORDING_AGE_S,
    POLL_INTERVAL,
    POLL_LOOKBACK_BUFFER,
    REOLINK_DOMAIN,
    SIGNAL_UPDATE,
)
from .database import RecordingsDB


def _sanitize(name: str) -> str:
    """Sanitize a string for use as a filesystem path component."""
    return "".join(c if c.isalnum() or c in "-_ " else "_" for c in name).strip()


_FILENAME_TIME_RE = re.compile(r"_(\d{8})_(\d{6})_(\d{6})")


def _parse_times_from_path(path: str) -> tuple[dt.datetime | None, dt.datetime | None]:
    """Parse start/end datetimes from a Reolink filename (e.g. RecM04_20260227_110232_110302_...)."""
    m = _FILENAME_TIME_RE.search(os.path.basename(path))
    if not m:
        return None, None
    date_s, start_s, end_s = m.groups()
    try:
        start = dt.datetime.strptime(date_s + start_s, "%Y%m%d%H%M%S")
        end = dt.datetime.strptime(date_s + end_s, "%Y%m%d%H%M%S")
        if end < start:
            end += dt.timedelta(days=1)  # recording crossed midnight
        return start, end
    except ValueError:
        return None, None


def _trigger_names(triggers: Any) -> list[str]:
    """Convert a VOD_trigger IntFlag value to a list of name strings."""
    if not triggers:
        return []
    return [t.name for t in VOD_trigger if t.value > 0 and bool(triggers & t)]


def _vod_type_for(filename: str, is_nvr: bool, is_hub: bool = False) -> VodRequestType | None:
    """Return the appropriate VodRequestType for a file, or None if not downloadable.

    Hub cameras use PLAYBACK/DOWNLOAD for all file types (mirrors Reolink media_source).
    NVR mp4/vref → DOWNLOAD; NVR other → FLV (HTTP, saveable).
    Camera mp4/vref → PLAYBACK; Camera other → RTMP (streaming, skip).
    """
    if filename.endswith((".mp4", ".vref")) or is_hub:
        return VodRequestType.DOWNLOAD if is_nvr else VodRequestType.PLAYBACK
    if is_nvr:
        return VodRequestType.FLV
    return None  # RTMP — not directly downloadable


_THUMB_WIDTH = 320
_FULL_QUALITY = 85
_THUMB_QUALITY = 70


def _extract_frames_sync(
    file_path: str, seek_s: float
) -> tuple[bytes | None, bytes | None]:
    """Decode one video frame and return (full_jpeg, thumb_jpeg) byte strings.

    Runs in a thread-pool executor — must not access the event loop.
    Returns (None, None) if av/Pillow is unavailable or decoding fails.
    """
    try:
        import av  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        LOGGER.warning(
            "av or Pillow not installed — frame extraction disabled. "
            "Ensure the integration is reloaded after HA finishes installing requirements."
        )
        return None, None

    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            if seek_s > 0:
                container.seek(int(seek_s * 1_000_000), any_frame=True)
            for frame in container.decode(stream):
                # Reformat to RGB24 for universal Pillow compatibility
                img = Image.fromarray(frame.reformat(format="rgb24").to_ndarray())

                # Full-size JPEG
                full_buf = io.BytesIO()
                img.save(full_buf, format="JPEG", quality=_FULL_QUALITY)

                # Thumbnail — scale down if wider than _THUMB_WIDTH
                w, h = img.size
                if w > _THUMB_WIDTH:
                    new_h = max(1, round(h * _THUMB_WIDTH / w))
                    try:
                        resample = Image.Resampling.LANCZOS
                    except AttributeError:
                        resample = Image.LANCZOS  # type: ignore[attr-defined]
                    thumb = img.resize((_THUMB_WIDTH, new_h), resample)
                else:
                    thumb = img
                thumb_buf = io.BytesIO()
                thumb.save(thumb_buf, format="JPEG", quality=_THUMB_QUALITY)

                return full_buf.getvalue(), thumb_buf.getvalue()
    except Exception as err:
        LOGGER.debug("Frame extraction failed for %s: %s", file_path, err)

    return None, None


class ReolinkDownloadCoordinator:
    """Manages downloading and local storage of Reolink camera recordings.

    Architecture:
    - A single asyncio.Queue serialises all downloads (one at a time).
    - A background polling loop checks for new recordings every POLL_INTERVAL s.
    - Disk space is managed by deleting the oldest tracked recordings when the
      limit would be exceeded by the next download.
    """

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        self.hass = hass
        self.config_entry = config_entry

        self._queue: asyncio.Queue[tuple[Any, int, str, Any, str]] = asyncio.Queue()
        self._worker_task: asyncio.Task | None = None
        self._poll_task: asyncio.Task | None = None

        self._db: RecordingsDB = RecordingsDB(DB_PATH)

        # Ordered list of tracked files, oldest first.
        # Each entry: {"path": str, "size": int, "downloaded_at": str, "camera": str}
        self._files: list[dict] = []
        self._total_bytes: int = 0

        # Paths currently in the download queue (prevents duplicates)
        self._queued_paths: set[str] = set()
        # Paths currently being downloaded (dequeued but not yet in _files)
        self._in_progress_paths: set[str] = set()
        # Display metadata for queued/downloading items (for UI visibility)
        self._pending_meta: dict[str, dict] = {}
        # Display metadata for recordings still being captured on the hub
        # (visible on hub but not yet eligible for download)
        self._recording_meta: dict[str, dict] = {}

        self._last_download: dt.datetime | None = None
        self._last_check: dict[str, dt.datetime] = {}

        # Camera schedule
        self._schedule: dict = {}
        self._schedule_store: Store | None = None
        self._schedule_unsubs: list = []

        # Manual recording timers — keyed by camera name
        # Each entry: {"started_at": datetime, "task": asyncio.Task, "entity_id": str}
        self._manual_rec_timers: dict[str, dict] = {}
        self._manual_rec_state_unsub: Any = None

        # Configurable timeouts (loaded from persistent store)
        self._timer_config_store: Store | None = None
        self._live_timeout_secs: int = 120
        self._record_timeout_secs: int = MANUAL_REC_TIMEOUT_SECS

    # ------------------------------------------------------------------ #
    # Public properties (read by sensors)                                  #
    # ------------------------------------------------------------------ #

    @property
    def max_disk_bytes(self) -> int:
        gb = self.config_entry.options.get(CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB)
        return int(gb * 1024**3)

    @property
    def stream(self) -> str:
        return self.config_entry.options.get(CONF_STREAM, DEFAULT_STREAM)

    @property
    def disk_used_bytes(self) -> int:
        return self._total_bytes

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    @property
    def total_recordings(self) -> int:
        return len(self._files)

    @property
    def last_download(self) -> dt.datetime | None:
        return self._last_download

    # ------------------------------------------------------------------ #
    # Lifecycle                                                            #
    # ------------------------------------------------------------------ #

    async def async_initialize(self) -> None:
        """Start the coordinator: load state, start worker/poll, queue init downloads."""
        await self.hass.async_add_executor_job(
            lambda: os.makedirs(MEDIA_BASE_DIR, exist_ok=True)
        )
        await self._db.async_init()
        await self._load_from_db()

        self._worker_task = self.hass.async_create_background_task(
            self._download_worker(), name="dragontree_reolink_worker"
        )
        self._poll_task = self.hass.async_create_background_task(
            self._polling_loop(), name="dragontree_reolink_poll"
        )

        # Load and activate camera schedule
        self._schedule_store = Store(self.hass, 1, f"{DOMAIN}_schedule")
        self._schedule = await self._schedule_store.async_load() or {}
        self._setup_schedule_timers()

        # Load configurable timer defaults
        self._timer_config_store = Store(self.hass, 1, f"{DOMAIN}_timer_config")
        timer_cfg = await self._timer_config_store.async_load() or {}
        self._live_timeout_secs = timer_cfg.get("live_timeout_secs", 120)
        self._record_timeout_secs = timer_cfg.get("record_timeout_secs", MANUAL_REC_TIMEOUT_SECS)

        # Watch manual_record switches for server-side timer management
        self._setup_manual_rec_tracking()

        # Generate thumbnails for recordings that don't have them yet
        self.hass.async_create_background_task(
            self._backfill_thumbnails(), name="dragontree_reolink_thumb_backfill"
        )

        # On startup, sweep the hub for recordings missed since last_download.
        # Falls back to count-based seed on a fresh install.
        self.hass.async_create_background_task(
            self._queue_startup_catchup(), name="dragontree_reolink_init"
        )

    async def async_unload(self) -> None:
        """Cancel all background tasks and unsubscribe dispatchers."""
        for unsub in self._schedule_unsubs:
            unsub()
        self._schedule_unsubs.clear()

        if self._manual_rec_state_unsub:
            self._manual_rec_state_unsub()
            self._manual_rec_state_unsub = None
        for entry in self._manual_rec_timers.values():
            entry["task"].cancel()
        self._manual_rec_timers.clear()

        if self._worker_task:
            self._worker_task.cancel()
        if self._poll_task:
            self._poll_task.cancel()

        await self._db.async_close()

    # ------------------------------------------------------------------ #
    # State persistence                                                    #
    # ------------------------------------------------------------------ #

    async def _load_from_db(self) -> None:
        """Load tracked files and poll state from the database."""
        raw_files = await self._db.get_files()
        raw_last_check = await self._db.get_last_check()

        existing: list[dict] = []
        for entry in raw_files:
            if await self.hass.async_add_executor_job(os.path.exists, entry["path"]):
                existing.append({"path": entry["path"], "camera": entry["camera"],
                                  "size": entry["file_size"], "downloaded_at": entry["downloaded_at"]})
            else:
                LOGGER.debug("Dropping missing file from tracking: %s", entry["path"])
                await self._db.delete(entry["path"])

        self._files = existing  # already ordered oldest-first by DB query
        self._total_bytes = sum(e["size"] for e in self._files)
        _last_dl_str = raw_last_check.pop("_last_download", None)
        self._last_download = (
            dt.datetime.fromisoformat(_last_dl_str)
            if _last_dl_str
            else None
        )
        self._last_check = {
            k: dt.datetime.fromisoformat(v).replace(tzinfo=None)
            for k, v in raw_last_check.items()
        }

        LOGGER.info(
            "Loaded %d tracked recordings (%.2f GB used)",
            len(self._files),
            self._total_bytes / 1024**3,
        )

    # ------------------------------------------------------------------ #
    # Polling loop                                                         #
    # ------------------------------------------------------------------ #

    async def _polling_loop(self) -> None:
        """Check all cameras for new recordings every POLL_INTERVAL seconds."""
        while True:
            try:
                await asyncio.sleep(POLL_INTERVAL)
                # Restart the worker if it died unexpectedly (not via cancellation)
                if self._worker_task and self._worker_task.done():
                    exc = self._worker_task.exception() if not self._worker_task.cancelled() else None
                    LOGGER.warning(
                        "Download worker task exited unexpectedly (exc=%s) — restarting", exc
                    )
                    self._worker_task = self.hass.async_create_background_task(
                        self._download_worker(), name="dragontree_reolink_worker"
                    )
                await self._check_all_channels()
            except asyncio.CancelledError:
                break
            except Exception as err:
                LOGGER.error("Unexpected error in polling loop: %s", err)

    async def _check_all_channels(self) -> None:
        for config_entry in self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
            try:
                host = config_entry.runtime_data.host
            except AttributeError:
                continue
            for channel in host.api.channels:
                if not self._channel_has_replay(host, channel):
                    continue
                await self._check_channel(config_entry.entry_id, channel)

    async def _check_channel(self, entry_id: str, channel: int) -> None:
        """Query a channel for recordings newer than the last check time.

        A POLL_LOOKBACK_BUFFER overlap is applied so recordings that the camera
        finishes writing after the previous poll window closes are not missed.
        Duplicate-checking in _maybe_enqueue ensures nothing is downloaded twice.
        """
        config_entry = self.hass.config_entries.async_get_entry(entry_id)
        if config_entry is None:
            return
        try:
            host = config_entry.runtime_data.host
        except AttributeError:
            return

        key = f"{entry_id}_{channel}"
        now = self._camera_now(host)
        last = self._last_check.get(key, now - dt.timedelta(seconds=POLL_INTERVAL * 2))
        query_from = last - dt.timedelta(seconds=POLL_LOOKBACK_BUFFER)

        try:
            statuses, _ = await host.api.request_vod_files(
                channel, query_from, now, status_only=True, stream=self.stream
            )
        except Exception as err:
            LOGGER.warning(
                "Failed to list recording days for %s ch%s: %s",
                host.api.nvr_name, channel, err,
            )
            return

        # Snapshot existing recording_meta keys for this channel so we can prune stale ones.
        old_recording = {fp for fp, m in self._recording_meta.items() if m.get("_channel_key") == key}
        # Clear them now; _maybe_enqueue will re-add any that are still active.
        for fp in old_recording:
            self._recording_meta.pop(fp, None)

        for status in statuses:
            for day in status.days:
                day_start = dt.datetime(status.year, status.month, day, 0, 0, 0)
                day_end = dt.datetime(status.year, status.month, day, 23, 59, 59)
                if day_end < query_from:
                    continue
                try:
                    _, vod_files = await host.api.request_vod_files(
                        channel, day_start, day_end, stream=self.stream
                    )
                except Exception as err:
                    LOGGER.warning(
                        "Failed to list files for ch%s %d/%02d/%02d: %s",
                        channel, status.year, status.month, day, err,
                    )
                    continue
                for vod_file in vod_files:
                    vod_start = vod_file.start_time.replace(tzinfo=None)
                    if vod_start >= query_from:
                        await self._maybe_enqueue(host, channel, entry_id, vod_file, channel_key=key)

        new_recording = {fp for fp in self._recording_meta if self._recording_meta[fp].get("_channel_key") == key}
        if old_recording != new_recording:
            self.hass.bus.async_fire(EVENT_QUEUE_CHANGED)

        self._last_check[key] = now
        await self._db.upsert_last_check(key, now.isoformat())

    # ------------------------------------------------------------------ #
    # Initial downloads                                                    #
    # ------------------------------------------------------------------ #

    async def _queue_startup_catchup(self) -> None:
        """Queue recordings missed since the last successful download.

        If last_download is known, sweeps every channel from that time to now.
        Falls back to count-based seeding on a fresh install (no last_download).
        """
        if self._last_download is None:
            LOGGER.info("No last_download recorded — running initial seed")
            await self._queue_initial_downloads()
            return

        catchup_from = self._last_download.replace(tzinfo=None)
        LOGGER.info("Startup catchup: queuing recordings since %s", catchup_from.isoformat())

        for config_entry in self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
            try:
                host = config_entry.runtime_data.host
            except AttributeError:
                continue
            for channel in host.api.channels:
                if not self._channel_has_replay(host, channel):
                    continue
                now = self._camera_now(host)
                try:
                    statuses, _ = await host.api.request_vod_files(
                        channel, catchup_from, now, status_only=True, stream=self.stream
                    )
                except Exception as err:
                    LOGGER.warning(
                        "Startup catchup: failed to list days for %s ch%s: %s",
                        host.api.camera_name(channel), channel, err,
                    )
                    continue
                for status in statuses:
                    for day in status.days:
                        day_start = dt.datetime(status.year, status.month, day, 0, 0, 0)
                        day_end = dt.datetime(status.year, status.month, day, 23, 59, 59)
                        if day_end < catchup_from:
                            continue
                        try:
                            _, vod_files = await host.api.request_vod_files(
                                channel, day_start, day_end, stream=self.stream
                            )
                        except Exception as err:
                            LOGGER.warning(
                                "Startup catchup: failed to list files for ch%s %d/%02d/%02d: %s",
                                channel, status.year, status.month, day, err,
                            )
                            continue
                        for vod_file in vod_files:
                            vod_start = vod_file.start_time.replace(tzinfo=None)
                            if vod_start >= catchup_from:
                                await self._maybe_enqueue(
                                    host, channel, config_entry.entry_id, vod_file
                                )

    async def _queue_initial_downloads(self) -> None:
        """Queue the N most recent recordings from every available camera."""
        for config_entry in self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
            try:
                host = config_entry.runtime_data.host
            except AttributeError:
                continue

            for channel in host.api.channels:
                if not self._channel_has_replay(host, channel):
                    continue
                await self._queue_recent(
                    config_entry.entry_id, host, channel,
                    count=INIT_RECORDINGS_PER_CAMERA,
                )

    async def _queue_recent(
        self, entry_id: str, host: Any, channel: int, count: int
    ) -> None:
        """Queue the `count` most recent recordings from a channel.

        Uses the same two-step process as the Reolink media source:
        1. Request day statuses over the lookback window.
        2. For each day newest-first, fetch individual files until `count` queued.
        """
        now = self._camera_now(host)
        start = now - dt.timedelta(days=INIT_LOOKBACK_DAYS)
        cam_name = host.api.camera_name(channel)

        try:
            statuses, _ = await host.api.request_vod_files(
                channel, start, now, status_only=True, stream=self.stream
            )
        except Exception as err:
            LOGGER.warning(
                "Failed to list recording days for %s ch%s: %s",
                cam_name, channel, err,
            )
            return

        day_list: list[tuple[int, int, int]] = sorted(
            (
                (status.year, status.month, day)
                for status in statuses
                for day in status.days
            ),
            reverse=True,
        )

        LOGGER.info(
            "ch%s '%s': %d recording day(s) found", channel, cam_name, len(day_list)
        )

        queued = 0
        for year, month, day in day_list:
            if queued >= count:
                break
            day_start = dt.datetime(year, month, day, 0, 0, 0)
            day_end = dt.datetime(year, month, day, 23, 59, 59)
            try:
                _, vod_files = await host.api.request_vod_files(
                    channel, day_start, day_end, stream=self.stream
                )
            except Exception as err:
                LOGGER.warning(
                    "Failed to list files for ch%s %d/%02d/%02d: %s",
                    channel, year, month, day, err,
                )
                continue

            for vod_file in sorted(vod_files, key=lambda f: f.start_time, reverse=True):
                if queued >= count:
                    break
                if await self._maybe_enqueue(host, channel, entry_id, vod_file):
                    queued += 1

    # ------------------------------------------------------------------ #
    # Enqueue logic                                                        #
    # ------------------------------------------------------------------ #

    async def _maybe_enqueue(
        self, host: Any, channel: int, entry_id: str, vod_file: Any,
        channel_key: str | None = None,
    ) -> bool:
        """Enqueue a VOD file for download if not already tracked/queued/on disk."""
        is_hub = getattr(host.api, "is_hub", False)
        vod_type = _vod_type_for(vod_file.file_name, host.api.is_nvr, is_hub)
        if vod_type is None:
            return False

        # Skip recordings still being written.
        # The hub sets end_time to None while the file is open; once finalized
        # it carries a real end_time.  As a belt-and-suspenders check, also
        # skip filenames where the hub encodes end time as 000000 (older firmware).
        end_time = getattr(vod_file, "end_time", None)
        file_path = self._make_file_path(host, channel, vod_file)
        if end_time is None:
            LOGGER.debug("Skipping in-progress recording (no end_time): %s", vod_file.file_name)
            self._mark_recording(host, channel, vod_file, file_path, channel_key)
            return False
        m = _FILENAME_TIME_RE.search(os.path.basename(vod_file.file_name))
        if m and m.group(3) == "000000":
            LOGGER.debug("Skipping in-progress recording (000000 end): %s", vod_file.file_name)
            self._mark_recording(host, channel, vod_file, file_path, channel_key)
            return False
        # The hub continuously updates end_time while recording (to roughly "now"),
        # so a non-None end_time does not mean the recording is complete.  Only
        # download once end_time is at least MIN_RECORDING_AGE_S seconds in the past.
        end_naive = end_time.replace(tzinfo=None) if getattr(end_time, "tzinfo", None) else end_time
        cutoff = self._camera_now(host) - dt.timedelta(seconds=MIN_RECORDING_AGE_S)
        if end_naive > cutoff:
            LOGGER.debug(
                "Skipping recording not yet old enough (end=%s cutoff=%s): %s",
                end_naive.isoformat(), cutoff.isoformat(), vod_file.file_name,
            )
            self._mark_recording(host, channel, vod_file, file_path, channel_key)
            return False

        # File is now eligible for download — remove any recording-state entry.
        self._recording_meta.pop(file_path, None)

        if any(f["path"] == file_path for f in self._files):
            return False
        if file_path in self._queued_paths:
            return False
        if file_path in self._in_progress_paths:
            return False

        # Reserve the slot before the first await so a concurrent call for the
        # same path (e.g. startup catchup + poll) cannot also pass the
        # in-memory checks and enqueue a duplicate.
        self._queued_paths.add(file_path)
        self._pending_meta[file_path] = self._build_pending_meta(
            host, channel, vod_file, file_path, "queued"
        )

        exists = await self.hass.async_add_executor_job(os.path.exists, file_path)
        if exists:
            # File exists but wasn't tracked — adopt it (un-reserve first)
            self._queued_paths.discard(file_path)
            self._pending_meta.pop(file_path, None)
            size = await self.hass.async_add_executor_job(os.path.getsize, file_path)
            downloaded_at = dt.datetime.now().isoformat()
            self._files.append({
                "path": file_path,
                "size": size,
                "downloaded_at": downloaded_at,
                "camera": host.api.camera_name(channel),
            })
            self._total_bytes += size
            await self._db.upsert(
                self._build_db_record(host, channel, vod_file, file_path, size, downloaded_at)
            )
            return False

        await self._queue.put((host, channel, entry_id, vod_file, file_path))
        LOGGER.debug(
            "Queued: %s ch%s → %s (depth %d)",
            host.api.camera_name(channel), channel,
            os.path.basename(file_path), self._queue.qsize(),
        )
        self._notify_sensors()
        self.hass.bus.async_fire(EVENT_QUEUE_CHANGED)
        return True

    # ------------------------------------------------------------------ #
    # Download worker                                                      #
    # ------------------------------------------------------------------ #

    async def _download_worker(self) -> None:
        """Process the queue one download at a time."""
        while True:
            try:
                host, channel, entry_id, vod_file, file_path = await self._queue.get()
                self._queued_paths.discard(file_path)
                self._in_progress_paths.add(file_path)
                if file_path in self._pending_meta:
                    self._pending_meta[file_path]["status"] = "downloading"
                self._notify_sensors()
                self.hass.bus.async_fire(EVENT_QUEUE_CHANGED)
                try:
                    await self._download_file(host, channel, vod_file, file_path)
                except Exception as err:
                    LOGGER.error(
                        "Download failed for %s: %s", os.path.basename(file_path), err
                    )
                finally:
                    self._in_progress_paths.discard(file_path)
                    self._pending_meta.pop(file_path, None)
                    self._queue.task_done()
                    self._notify_sensors()
            except asyncio.CancelledError:
                break
            except Exception as err:
                LOGGER.error("Unexpected error in download worker: %s", err)

    async def _download_file(
        self, host: Any, channel: int, vod_file: Any, file_path: str
    ) -> None:
        """Download one VOD file to local storage."""
        filename = vod_file.file_name
        is_hub = getattr(host.api, "is_hub", False)
        vod_type = _vod_type_for(filename, host.api.is_nvr, is_hub)
        if vod_type is None:
            return

        camera_name = host.api.camera_name(channel)

        try:
            _mime_type, url = await host.api.get_vod_source(
                channel, filename, self.stream, vod_type
            )
        except Exception as err:
            LOGGER.warning("Failed to get VOD URL for %s: %s", filename, err)
            return

        dir_path = os.path.dirname(file_path)
        await self.hass.async_add_executor_job(
            lambda: os.makedirs(dir_path, exist_ok=True)
        )

        tmp_path = file_path + ".tmp"
        session = async_get_clientsession(
            self.hass, verify_ssl=False, ssl_cipher=SSLCipherList.INSECURE,
        )

        total_size = 0
        try:
            async with session.get(
                url,
                timeout=ClientTimeout(total=300, connect=30, sock_connect=30, sock_read=120),
            ) as resp:
                if resp.status != 200:
                    LOGGER.warning("HTTP %s fetching %s — skipping", resp.status, filename)
                    return
                async with aiofiles.open(tmp_path, "wb") as fh:
                    async for chunk in resp.content.iter_chunked(65536):
                        total_size += len(chunk)
                        await fh.write(chunk)
        except asyncio.CancelledError:
            await self._remove_tmp(tmp_path)
            raise
        except Exception as err:
            LOGGER.warning("Error downloading %s: %s", filename, err)
            await self._remove_tmp(tmp_path)
            return

        if total_size == 0:
            LOGGER.warning("Empty response for %s — skipping", filename)
            await self._remove_tmp(tmp_path)
            return

        await self._ensure_space(total_size)
        await self.hass.async_add_executor_job(os.rename, tmp_path, file_path)

        downloaded_at = dt_util.now()
        self._files.append({
            "path": file_path,
            "size": total_size,
            "downloaded_at": downloaded_at.isoformat(),
            "camera": camera_name,
        })
        self._total_bytes += total_size
        self._last_download = downloaded_at
        await self._db.upsert_last_check("_last_download", downloaded_at.isoformat())

        # Extract frames for thumbnail and full-size image
        _start = getattr(vod_file, "start_time", None)
        _end = getattr(vod_file, "end_time", None)
        if _start and _end:
            _s = _start.replace(tzinfo=None) if getattr(_start, "tzinfo", None) else _start
            _e = _end.replace(tzinfo=None) if getattr(_end, "tzinfo", None) else _end
            _dur: float | None = (_e - _s).total_seconds()
        else:
            _dur = None
        image_path, thumb_path = await self._extract_frames(file_path, _dur)

        await self._db.upsert(
            self._build_db_record(
                host, channel, vod_file, file_path, total_size,
                downloaded_at.isoformat(), image_path, thumb_path,
            )
        )
        self._notify_sensors()
        self.hass.bus.async_fire(EVENT_RECORDING_ADDED)

        LOGGER.info(
            "Saved %s (%.1f MB) — total %.2f / %.2f GB",
            os.path.basename(file_path),
            total_size / 1024**2,
            self._total_bytes / 1024**3,
            self.max_disk_bytes / 1024**3,
        )

    # ------------------------------------------------------------------ #
    # Disk space management                                                #
    # ------------------------------------------------------------------ #

    async def _ensure_space(self, needed_bytes: int) -> None:
        """Delete oldest recordings until there is room for `needed_bytes`."""
        if self._total_bytes + needed_bytes <= self.max_disk_bytes:
            return

        target = self.max_disk_bytes - needed_bytes
        while self._total_bytes > target and self._files:
            oldest = self._files.pop(0)
            path, size = oldest["path"], oldest["size"]
            self._total_bytes -= size
            try:
                await self.hass.async_add_executor_job(os.remove, path)
                LOGGER.info("Deleted oldest recording to free space: %s", os.path.basename(path))
            except FileNotFoundError:
                pass
            except OSError as err:
                LOGGER.warning("Could not delete %s: %s", path, err)
            # Also remove associated image files
            base = os.path.splitext(path)[0]
            for suffix in ("_full.jpg", "_thumb.jpg"):
                img = base + suffix
                try:
                    await self.hass.async_add_executor_job(
                        lambda p=img: os.remove(p) if os.path.exists(p) else None
                    )
                except OSError:
                    pass
            await self._db.delete(path)

        if self._total_bytes + needed_bytes > self.max_disk_bytes:
            LOGGER.warning(
                "Disk limit (%.2f GB) cannot fully accommodate a %.1f MB recording",
                self.max_disk_bytes / 1024**3, needed_bytes / 1024**2,
            )

    # ------------------------------------------------------------------ #
    # Manual recording timers                                             #
    # ------------------------------------------------------------------ #

    @callback
    def _setup_manual_rec_tracking(self) -> None:
        """Listen to all state changes and watch for manual_record switches."""
        if self._manual_rec_state_unsub:
            return

        @callback
        def _on_state_changed(event: Any) -> None:
            entity_id: str = event.data.get("entity_id", "")
            if not entity_id.endswith("_manual_record"):
                return
            old_state = event.data.get("old_state")
            new_state = event.data.get("new_state")
            if new_state is None:
                return

            cam_name = self._camera_name_for_entity(entity_id)
            if not cam_name:
                return

            was_on = old_state is not None and old_state.state == "on"
            is_on = new_state.state == "on"

            if is_on and not was_on:
                self._start_manual_rec_timer(cam_name, entity_id)
            elif not is_on and was_on:
                self._stop_manual_rec_timer(cam_name)

        self._manual_rec_state_unsub = self.hass.bus.async_listen(
            "state_changed", _on_state_changed
        )

    def _camera_name_for_entity(self, entity_id: str) -> str | None:
        """Return the camera name whose slug appears in the given entity_id, or None."""
        cam_slugs = self._collect_cam_slugs()
        for slug, name in cam_slugs.items():
            if slug in entity_id:
                return name
        return None

    def _start_manual_rec_timer(self, cam_name: str, entity_id: str) -> None:
        """Start a server-side countdown for a manual recording."""
        self._stop_manual_rec_timer(cam_name)  # cancel any existing timer first

        started_at = dt_util.utcnow()
        timeout = self._record_timeout_secs
        task = self.hass.async_create_background_task(
            self._manual_rec_timeout_task(cam_name, entity_id, timeout),
            name=f"dragontree_reolink_rec_timer_{cam_name}",
        )
        self._manual_rec_timers[cam_name] = {
            "started_at": started_at,
            "task": task,
            "entity_id": entity_id,
        }
        self.hass.bus.async_fire(EVENT_RECORD_TIMER_CHANGED, {
            "camera": cam_name,
            "action": "started",
            "started_at": started_at.isoformat(),
            "timeout_secs": timeout,
        })
        LOGGER.info("Manual recording timer started for %s (%ds)", cam_name, timeout)

    def _stop_manual_rec_timer(self, cam_name: str) -> None:
        """Cancel any running timer for the given camera and notify the frontend."""
        entry = self._manual_rec_timers.pop(cam_name, None)
        if entry:
            entry["task"].cancel()
        self.hass.bus.async_fire(EVENT_RECORD_TIMER_CHANGED, {
            "camera": cam_name,
            "action": "stopped",
        })

    async def _manual_rec_timeout_task(
        self, cam_name: str, entity_id: str, timeout_secs: int
    ) -> None:
        """Wait timeout_secs then turn off the manual record switch."""
        try:
            await asyncio.sleep(timeout_secs)
            LOGGER.info("Manual recording timed out for %s — stopping", cam_name)
            await self.hass.services.async_call(
                "switch", "turn_off", {"entity_id": entity_id}, blocking=False
            )
            # State change will trigger _stop_manual_rec_timer via the listener
        except asyncio.CancelledError:
            pass  # Stopped manually or integration unloaded

    def get_record_timers(self) -> dict[str, dict]:
        """Return current timer state for all cameras with active manual recordings."""
        now = dt_util.utcnow()
        result = {}
        for cam_name, entry in self._manual_rec_timers.items():
            elapsed = (now - entry["started_at"]).total_seconds()
            timeout = self._record_timeout_secs
            result[cam_name] = {
                "started_at": entry["started_at"].isoformat(),
                "timeout_secs": timeout,
                "seconds_remaining": max(0, timeout - elapsed),
            }
        return result

    def async_get_timer_config(self) -> dict:
        """Return the current live and recording timeout settings."""
        return {
            "live_timeout_secs": self._live_timeout_secs,
            "record_timeout_secs": self._record_timeout_secs,
        }

    async def async_set_timer_config(
        self, live_timeout_secs: int, record_timeout_secs: int
    ) -> None:
        """Persist new timeout settings."""
        self._live_timeout_secs = live_timeout_secs
        self._record_timeout_secs = record_timeout_secs
        await self._timer_config_store.async_save({
            "live_timeout_secs": live_timeout_secs,
            "record_timeout_secs": record_timeout_secs,
        })

    # ------------------------------------------------------------------ #
    # Camera schedule                                                      #
    # ------------------------------------------------------------------ #

    def _collect_cam_slugs(self) -> dict[str, str]:
        """Return {slug: camera_name} for all Reolink cameras, including offline ones.

        Primary source: the hub API (via loaded config entries).
        Fallback: the device registry, which retains stable device names even when
        a camera is offline and the hub API omits it or returns a placeholder name.
        """
        cam_slugs: dict[str, str] = {}
        for config_entry in self.hass.config_entries.async_entries(REOLINK_DOMAIN):
            try:
                host = config_entry.runtime_data.host
                for channel in host.api.channels:
                    cam_name = host.api.camera_name(channel)
                    cam_slugs[slugify(cam_name)] = cam_name
            except AttributeError:
                pass  # Entry not loaded; device registry fallback handles it below

        # Fallback: scan the device registry for any Reolink _pir_enabled switch
        # entities whose device name isn't yet in cam_slugs.  This covers cameras
        # that are offline and whose channel the hub API no longer enumerates.
        device_reg = dr.async_get(self.hass)
        entity_reg = er.async_get(self.hass)
        for entity in entity_reg.entities.values():
            if (
                entity.platform != REOLINK_DOMAIN
                or entity.domain != "switch"
                or not entity.entity_id.endswith("_pir_enabled")
            ):
                continue
            device = device_reg.async_get(entity.device_id) if entity.device_id else None
            if device and device.name:
                slug = slugify(device.name)
                if slug not in cam_slugs:
                    LOGGER.info("Camera %r found via device registry (not in hub API)", device.name)
                    cam_slugs[slug] = device.name

        return cam_slugs

    def _find_camera_entities(self) -> dict[str, str]:
        """Return {camera_name: camera_entity_id} for Reolink camera entities.

        Prefers the main stream entity over the sub stream (_sub suffix).
        """
        cam_slugs = self._collect_cam_slugs()

        if not cam_slugs:
            return {}

        all_camera_ids = self.hass.states.async_entity_ids("camera")
        result: dict[str, str] = {}

        for cam_slug, cam_name in cam_slugs.items():
            matches = [eid for eid in all_camera_ids if cam_slug in eid]
            if not matches:
                continue
            # Prefer main stream (non-_sub)
            main = [m for m in matches if not m.endswith("_sub")]
            result[cam_name] = main[0] if main else matches[0]

        return result

    def _find_cam_entities_by_suffix(self, suffix: str, domain: str) -> dict[str, str]:
        """Return {camera_name: entity_id} for Reolink entities matching suffix in domain."""
        cam_slugs = self._collect_cam_slugs()

        if not cam_slugs:
            return {}

        result: dict[str, str] = {}
        for entity_id in self.hass.states.async_entity_ids(domain):
            if not entity_id.endswith(suffix):
                continue
            for cam_slug, cam_name in cam_slugs.items():
                if cam_slug in entity_id and cam_name not in result:
                    result[cam_name] = entity_id
                    break

        if len(result) < len(cam_slugs):
            entity_reg = er.async_get(self.hass)
            for entity in entity_reg.entities.values():
                if (
                    entity.platform == REOLINK_DOMAIN
                    and entity.domain == domain
                    and entity.entity_id.endswith(suffix)
                ):
                    for cam_slug, cam_name in cam_slugs.items():
                        if cam_slug in entity.entity_id and cam_name not in result:
                            result[cam_name] = entity.entity_id
                            break

        return result

    def _find_pir_entities(self) -> dict[str, str]:
        """Return {camera_name: pir_entity_id} for all Reolink cameras.

        Searches hass.states (enabled entities only) so we only return
        entity_ids that actually have a live state the frontend can read.
        Falls back to the entity registry (disabled entities included) so
        camera rows still appear, but in that case enabled=None is returned.
        Includes offline cameras whose config entry is not currently loaded.
        """
        cam_slugs = self._collect_cam_slugs()

        if not cam_slugs:
            LOGGER.warning("No loaded Reolink config entries found")
            return {}

        # 1) Search enabled (stateful) switch entities first
        result: dict[str, str] = {}
        pir_switch_ids = [
            eid for eid in self.hass.states.async_entity_ids("switch")
            if eid.endswith("_pir_enabled")
        ]
        LOGGER.info("All enabled switch entities ending in _pir_enabled: %s", pir_switch_ids)

        for entity_id in pir_switch_ids:
            for cam_slug, cam_name in cam_slugs.items():
                if cam_slug in entity_id and cam_name not in result:
                    result[cam_name] = entity_id
                    LOGGER.info("PIR entity matched: %s -> %s", cam_name, entity_id)
                    break

        # 2) For cameras still missing, fall back to the entity registry
        #    (covers disabled entities — their state will be None)
        if len(result) < len(cam_slugs):
            entity_reg = er.async_get(self.hass)
            for entity in entity_reg.entities.values():
                if (
                    entity.platform == REOLINK_DOMAIN
                    and entity.domain == "switch"
                    and entity.entity_id.endswith("_pir_enabled")
                ):
                    for cam_slug, cam_name in cam_slugs.items():
                        if cam_slug in entity.entity_id and cam_name not in result:
                            result[cam_name] = entity.entity_id
                            LOGGER.warning(
                                "PIR entity %s found in registry but has no state "
                                "(likely disabled in HA). Enable it via Settings → "
                                "Devices & Services → Reolink → Entities.",
                                entity.entity_id,
                            )
                            break

        if not result:
            LOGGER.warning(
                "No _pir_enabled switch entities found. "
                "Camera slugs searched: %s. "
                "All Reolink switch entities in registry: %s",
                list(cam_slugs.keys()),
                [e.entity_id for e in er.async_get(self.hass).entities.values()
                 if e.platform == REOLINK_DOMAIN and e.domain == "switch"],
            )

        return result

    async def async_get_cameras_config(self) -> list[dict]:
        """Return per-camera config."""
        pir_entities = self._find_pir_entities()
        rfa_entities = self._find_cam_entities_by_suffix("_pir_reduce_false_alarm", "switch")
        sens_entities = self._find_cam_entities_by_suffix("_pir_sensitivity", "number")
        record_entities = self._find_cam_entities_by_suffix("_manual_record", "switch")
        camera_entities = self._find_camera_entities()
        cameras_cfg = self._schedule.get("cameras", {})
        result = []
        for cam_name, pir_entity_id in pir_entities.items():
            state = self.hass.states.get(pir_entity_id)
            in_schedule = cameras_cfg.get(cam_name, {}).get("in_schedule", False)

            rfa_entity_id = rfa_entities.get(cam_name)
            rfa_state = self.hass.states.get(rfa_entity_id) if rfa_entity_id else None

            sens_entity_id = sens_entities.get(cam_name)
            sens_state = self.hass.states.get(sens_entity_id) if sens_entity_id else None

            # A camera is offline when its PIR entity is unavailable (camera unreachable)
            online = state is not None and state.state not in ("unavailable", "unknown")

            def _bool_state(s):
                return s.state == "on" if (s and s.state not in ("unavailable", "unknown")) else None

            def _float_state(s):
                if not s or s.state in ("unavailable", "unknown"):
                    return None
                try:
                    return float(s.state)
                except (ValueError, TypeError):
                    return None

            result.append({
                "name": cam_name,
                "online": online,
                "pir_entity_id": pir_entity_id,
                "rfa_entity_id": rfa_entity_id,
                "sensitivity_entity_id": sens_entity_id,
                "record_entity_id": record_entities.get(cam_name),
                "camera_entity_id": camera_entities.get(cam_name),
                "in_schedule": in_schedule,
                "enabled": _bool_state(state),
                "rfa_enabled": _bool_state(rfa_state),
                "sensitivity": _float_state(sens_state),
                "sensitivity_min": float(sens_state.attributes.get("min", 0)) if sens_state else 0,
                "sensitivity_max": float(sens_state.attributes.get("max", 100)) if sens_state else 100,
            })
        return result

    def async_get_schedule(self) -> dict:
        """Return current schedule settings."""
        return {
            "enabled": self._schedule.get("schedule_enabled", False),
            "start_time": self._schedule.get("start_time", "22:00"),
            "stop_time": self._schedule.get("stop_time", "06:00"),
        }

    async def async_set_schedule(self, enabled: bool, start_time: str, stop_time: str) -> None:
        """Persist new schedule settings and apply them immediately."""
        self._schedule["schedule_enabled"] = enabled
        self._schedule["start_time"] = start_time
        self._schedule["stop_time"] = stop_time
        await self._schedule_store.async_save(self._schedule)
        self._setup_schedule_timers()
        if enabled:
            await self._apply_schedule()

    async def async_set_camera_in_schedule(self, camera_name: str, in_schedule: bool) -> None:
        """Update whether a specific camera is included in the schedule."""
        cameras = self._schedule.setdefault("cameras", {})
        cameras.setdefault(camera_name, {})["in_schedule"] = in_schedule
        await self._schedule_store.async_save(self._schedule)

    def _is_within_schedule(self) -> bool:
        """Return True if the current local time falls within the on-window."""
        start = self._schedule.get("start_time", "22:00")
        stop = self._schedule.get("stop_time", "06:00")
        now = dt_util.now().strftime("%H:%M")
        if start <= stop:
            return start <= now < stop
        # Crosses midnight (e.g. 22:00 → 06:00)
        return now >= start or now < stop

    async def _apply_schedule(self) -> None:
        """Turn in-schedule cameras on or off depending on the current time."""
        if not self._schedule.get("schedule_enabled"):
            return
        pir_entities = self._find_pir_entities()
        cameras_cfg = self._schedule.get("cameras", {})
        service = "turn_on" if self._is_within_schedule() else "turn_off"
        for cam_name, pir_entity_id in pir_entities.items():
            if cameras_cfg.get(cam_name, {}).get("in_schedule", False):
                await self.hass.services.async_call(
                    "switch", service,
                    {"entity_id": pir_entity_id},
                    blocking=False,
                )
        LOGGER.debug("Schedule applied: %s (within_window=%s)", service, self._is_within_schedule())

    def _setup_schedule_timers(self) -> None:
        """Register time-change callbacks for the schedule start and stop times."""
        for unsub in self._schedule_unsubs:
            unsub()
        self._schedule_unsubs.clear()

        if not self._schedule.get("schedule_enabled"):
            return

        start = self._schedule.get("start_time", "22:00")
        stop = self._schedule.get("stop_time", "06:00")
        try:
            sh, sm = (int(x) for x in start.split(":"))
            eh, em = (int(x) for x in stop.split(":"))
        except (ValueError, AttributeError):
            LOGGER.warning("Invalid schedule times: start=%s stop=%s", start, stop)
            return

        @callback
        def _on_start(_now: Any) -> None:
            self.hass.async_create_background_task(
                self._apply_schedule(), name="dragontree_reolink_schedule_start"
            )

        @callback
        def _on_stop(_now: Any) -> None:
            self.hass.async_create_background_task(
                self._apply_schedule(), name="dragontree_reolink_schedule_stop"
            )

        self._schedule_unsubs.append(
            async_track_time_change(self.hass, _on_start, hour=sh, minute=sm, second=0)
        )
        self._schedule_unsubs.append(
            async_track_time_change(self.hass, _on_stop, hour=eh, minute=em, second=0)
        )
        LOGGER.info("Schedule timers set: ON at %s, OFF at %s", start, stop)

    # ------------------------------------------------------------------ #
    # Helpers                                                              #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _channel_has_replay(host: Any, channel: int) -> bool:
        """Return True if the channel supports VOD replay."""
        return host.api.supported(channel, "replay")

    @staticmethod
    def _camera_now(host: Any) -> dt.datetime:
        """Return the camera's current time as a naive datetime (falls back to local time)."""
        try:
            t = host.api.time() or dt.datetime.now()
            return t.replace(tzinfo=None)
        except Exception:
            return dt.datetime.now()

    def _make_file_path(self, host: Any, channel: int, vod_file: Any) -> str:
        """Build the local filesystem path for a VOD file.

        Structure:
          <MEDIA_BASE_DIR>/<camera_name>/<stream>/<year>/<mm>/<dd>/<filename>
        """
        camera_name = _sanitize(host.api.camera_name(channel))
        dt_obj: dt.datetime = vod_file.start_time
        filename = os.path.basename(vod_file.file_name)

        # FLV files get .flv extension if not already present
        if vod_file.file_name.endswith(".flv") and not filename.endswith(".flv"):
            filename += ".flv"

        return os.path.join(
            MEDIA_BASE_DIR,
            camera_name,
            self.stream,
            str(dt_obj.year),
            f"{dt_obj.month:02d}",
            f"{dt_obj.day:02d}",
            filename,
        )

    def _build_db_record(
        self,
        host: Any,
        channel: int,
        vod_file: Any,
        file_path: str,
        file_size: int,
        downloaded_at: str,
        image_path: str | None = None,
        thumb_path: str | None = None,
    ) -> dict:
        """Build a metadata dict for inserting into the recordings DB."""
        start = getattr(vod_file, "start_time", None)
        end = getattr(vod_file, "end_time", None)
        # Normalise to naive datetimes
        if start and getattr(start, "tzinfo", None):
            start = start.replace(tzinfo=None)
        if end and getattr(end, "tzinfo", None):
            end = end.replace(tzinfo=None)
        duration = (end - start).total_seconds() if start and end else None
        triggers = _trigger_names(getattr(vod_file, "triggers", None))
        return {
            "path": file_path,
            "camera": host.api.camera_name(channel),
            "channel": channel,
            "stream": self.stream,
            "start_time": start.isoformat() if start else None,
            "end_time": end.isoformat() if end else None,
            "duration_s": duration,
            "triggers": json.dumps(triggers),
            "file_size": file_size,
            "downloaded_at": downloaded_at,
            "image_path": image_path,
            "thumb_path": thumb_path,
        }

    async def _extract_frames(
        self, file_path: str, duration_s: float | None
    ) -> tuple[str | None, str | None]:
        """Extract full-size and thumbnail JPEGs from a downloaded recording.

        Returns (image_path, thumb_path) with absolute paths on success,
        or (None, None) if extraction fails or av is not available.
        """
        seek = 1.0 if (duration_s and duration_s > 2.0) else 0.0
        base = os.path.splitext(file_path)[0]
        image_path = base + "_full.jpg"
        thumb_path = base + "_thumb.jpg"

        full_bytes, thumb_bytes = await self.hass.async_add_executor_job(
            _extract_frames_sync, file_path, seek
        )
        if not full_bytes:
            return None, None

        async with aiofiles.open(image_path, "wb") as fh:
            await fh.write(full_bytes)
        async with aiofiles.open(thumb_path, "wb") as fh:
            await fh.write(thumb_bytes or full_bytes)

        return image_path, (thumb_path if thumb_bytes else None)

    async def _backfill_thumbnails(self) -> None:
        """Generate thumbnails for recordings that predate this feature."""
        rows = await self._db.get_files_without_thumbnails()
        if not rows:
            return
        LOGGER.info("Generating thumbnails for %d existing recordings", len(rows))
        for row in rows:
            file_path = row["path"]
            exists = await self.hass.async_add_executor_job(os.path.exists, file_path)
            if not exists:
                continue
            start, end = _parse_times_from_path(file_path)
            dur = (end - start).total_seconds() if start and end else None
            image_path, thumb_path = await self._extract_frames(file_path, dur)
            if image_path or thumb_path:
                await self._db.update_image_paths(file_path, image_path, thumb_path)
            # Yield control between files so we don't hog the event loop
            await asyncio.sleep(0.1)
        LOGGER.info("Thumbnail backfill complete")

    def get_pending_recordings(self) -> list[dict]:
        """Return metadata for recordings currently recording, queued, or downloading."""
        # Strip internal _channel_key before sending to the frontend
        recording = [
            {k: v for k, v in m.items() if k != "_channel_key"}
            for m in self._recording_meta.values()
        ]
        return recording + list(self._pending_meta.values())

    def _mark_recording(
        self,
        host: Any,
        channel: int,
        vod_file: Any,
        file_path: str,
        channel_key: str | None,
    ) -> None:
        """Add/update a recording-state entry for a file still being captured on the hub."""
        if (
            any(f["path"] == file_path for f in self._files)
            or file_path in self._queued_paths
            or file_path in self._in_progress_paths
        ):
            return
        meta = self._build_pending_meta(host, channel, vod_file, file_path, "recording")
        if channel_key:
            meta["_channel_key"] = channel_key
        self._recording_meta[file_path] = meta

    def _build_pending_meta(
        self, host: Any, channel: int, vod_file: Any, file_path: str, status: str
    ) -> dict:
        """Build a minimal display dict for a queued/in-progress recording."""
        start = getattr(vod_file, "start_time", None)
        end = getattr(vod_file, "end_time", None)
        if start and getattr(start, "tzinfo", None):
            start = start.replace(tzinfo=None)
        if end and getattr(end, "tzinfo", None):
            end = end.replace(tzinfo=None)
        duration = (end - start).total_seconds() if start and end else None
        triggers = _trigger_names(getattr(vod_file, "triggers", None))
        return {
            "path": file_path,
            "camera": host.api.camera_name(channel),
            "start_time": start.isoformat() if start else None,
            "end_time": end.isoformat() if end else None,
            "duration_s": duration,
            "triggers": json.dumps(triggers),
            "status": status,
        }

    def _notify_sensors(self) -> None:
        """Push an update signal so sensors refresh their state."""
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    async def _remove_tmp(self, tmp_path: str) -> None:
        """Remove a temp file if it exists, ignoring errors."""
        try:
            await self.hass.async_add_executor_job(
                lambda: os.remove(tmp_path) if os.path.exists(tmp_path) else None
            )
        except Exception:
            pass
