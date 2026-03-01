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
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util, slugify
from homeassistant.util.ssl import SSLCipherList

from aiohttp import ClientTimeout

from .const import (
    CONF_MAX_DISK_GB,
    CONF_STREAM,
    DB_PATH,
    DEFAULT_MAX_DISK_GB,
    DEFAULT_STREAM,
    INIT_LOOKBACK_DAYS,
    INIT_RECORDINGS_PER_CAMERA,
    LOGGER,
    MEDIA_BASE_DIR,
    MOTION_END_DELAY,
    MOTION_START_FALLBACK_DELAY,
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
    - Reolink dispatcher motion signals trigger an additional 60-second-delayed
      per-channel check so recent recordings are picked up quickly.
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

        self._last_download: dt.datetime | None = None
        self._last_check: dict[str, dt.datetime] = {}

        # Per-channel debounce tasks for motion-triggered checks
        self._pending_checks: dict[str, asyncio.Task] = {}

        # Channels currently known to have motion active (key = f"{entry_id}_{channel}")
        self._motion_active: set[str] = set()

        # Dispatcher unsubscribe callbacks
        self._unsub_dispatchers: list = []

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

        self._subscribe_to_reolink_events()

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
        for unsub in self._unsub_dispatchers:
            unsub()
        self._unsub_dispatchers.clear()

        for task in list(self._pending_checks.values()):
            task.cancel()
        self._pending_checks.clear()

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
            dt.datetime.fromisoformat(_last_dl_str).replace(tzinfo=None)
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
    # Reolink event subscription (motion-triggered checks)                 #
    # ------------------------------------------------------------------ #

    def _subscribe_to_reolink_events(self) -> None:
        """Subscribe to HA state-change events on Reolink motion binary sensors.

        Builds a mapping of motion sensor entity_id → (entry_id, channel) by
        matching each channel's camera name slug against the entity registry.
        This is more reliable than Reolink's internal dispatcher signals, which
        behave differently on the Home Hub.
        """
        entity_reg = er.async_get(self.hass)

        # Map motion sensor entity_id → (entry_id, channel)
        channel_map: dict[str, tuple[str, int]] = {}

        for config_entry in self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
            try:
                host = config_entry.runtime_data.host
            except AttributeError:
                continue
            for channel in host.api.channels:
                cam_slug = slugify(host.api.camera_name(channel))
                for entity in entity_reg.entities.values():
                    if (
                        entity.platform == REOLINK_DOMAIN
                        and entity.domain == "binary_sensor"
                        and entity.entity_id.endswith("_motion")
                        and cam_slug in entity.entity_id
                    ):
                        channel_map[entity.entity_id] = (config_entry.entry_id, channel)
                        break

        if not channel_map:
            LOGGER.warning("No Reolink motion sensors found — relying on poll only")
            return

        LOGGER.info("Subscribed to motion sensors: %s", list(channel_map.keys()))

        @callback
        def _on_motion_state_change(event: Any) -> None:
            entity_id = event.data.get("entity_id")
            new_state = event.data.get("new_state")
            old_state = event.data.get("old_state")
            if not new_state or not old_state or entity_id not in channel_map:
                return

            entry_id, channel = channel_map[entity_id]
            key = f"{entry_id}_{channel}"

            if new_state.state == "on" and old_state.state != "on":
                self._motion_active.add(key)
                LOGGER.debug("Motion started ch%s (%s) — fallback in %ds", channel, entity_id, MOTION_START_FALLBACK_DELAY)
                self._schedule_channel_check(entry_id, channel, delay=MOTION_START_FALLBACK_DELAY)
            elif new_state.state == "off" and old_state.state == "on":
                self._motion_active.discard(key)
                LOGGER.debug("Motion ended ch%s (%s) — check in %ds", channel, entity_id, MOTION_END_DELAY)
                self._schedule_channel_check(entry_id, channel, delay=MOTION_END_DELAY)

        unsub = async_track_state_change_event(
            self.hass, list(channel_map.keys()), _on_motion_state_change
        )
        self._unsub_dispatchers.append(unsub)

    def _schedule_channel_check(self, entry_id: str, channel: int, delay: int = MOTION_END_DELAY) -> None:
        """Schedule a channel check after `delay` seconds, cancelling any pending one.

        MOTION_END_DELAY is used when motion has ended (accounts for post-motion
        recording extension + hub finalization). MOTION_START_FALLBACK_DELAY is
        used as a fallback when motion just started, in case OFF never arrives.
        """
        key = f"{entry_id}_{channel}"
        existing = self._pending_checks.pop(key, None)
        if existing:
            existing.cancel()
        task = self.hass.async_create_background_task(
            self._delayed_channel_check(entry_id, channel, delay),
            name=f"dragontree_reolink_check_{key}",
        )
        self._pending_checks[key] = task

    async def _delayed_channel_check(self, entry_id: str, channel: int, delay: int) -> None:
        """Wait `delay` seconds, then scan for new recordings."""
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        self._pending_checks.pop(f"{entry_id}_{channel}", None)
        await self._check_channel(entry_id, channel)

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
                        await self._maybe_enqueue(host, channel, entry_id, vod_file)

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

        catchup_from = self._last_download
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
        self, host: Any, channel: int, entry_id: str, vod_file: Any
    ) -> bool:
        """Enqueue a VOD file for download if not already tracked/queued/on disk."""
        is_hub = getattr(host.api, "is_hub", False)
        vod_type = _vod_type_for(vod_file.file_name, host.api.is_nvr, is_hub)
        if vod_type is None:
            return False

        # Skip recordings still being written — the hub sets end time to 000000
        # in the filename while the file is open. The finalized version (with a
        # real end time) will be picked up on the next poll.
        m = _FILENAME_TIME_RE.search(os.path.basename(vod_file.file_name))
        if m and m.group(3) == "000000":
            LOGGER.debug("Skipping in-progress recording: %s", vod_file.file_name)
            return False

        file_path = self._make_file_path(host, channel, vod_file)

        if any(f["path"] == file_path for f in self._files):
            return False
        if file_path in self._queued_paths:
            return False

        exists = await self.hass.async_add_executor_job(os.path.exists, file_path)
        if exists:
            # File exists but wasn't tracked — adopt it
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

        self._queued_paths.add(file_path)
        await self._queue.put((host, channel, entry_id, vod_file, file_path))
        LOGGER.debug(
            "Queued: %s ch%s → %s (depth %d)",
            host.api.camera_name(channel), channel,
            os.path.basename(file_path), self._queue.qsize(),
        )
        self._notify_sensors()
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
                try:
                    await self._download_file(host, channel, vod_file, file_path)
                except Exception as err:
                    LOGGER.error(
                        "Download failed for %s: %s", os.path.basename(file_path), err
                    )
                finally:
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
