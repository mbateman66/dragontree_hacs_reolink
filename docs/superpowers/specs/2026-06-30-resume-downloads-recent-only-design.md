# Design: Resume Downloads → Last N Per Camera

**Date:** 2026-06-30
**Status:** Approved

---

## Overview

Changes what happens when the download-disable toggle (added earlier on this branch) transitions from **disabled → enabled**. Previously (after the `_check_channel` poll-cursor fix), re-enabling would catch up the *entire* historical gap since the toggle was disabled — every recording made during the disabled window, uncapped. This is now replaced with the same bounded "last N per camera" behavior the fresh-install seed already uses.

## Background

- `_check_channel`'s poll cursor (`_last_check[key]`) freezes while downloads are disabled (existing fix, commit `60a4207`). On re-enable, the next poll's lookback window naturally reopens to cover the entire disabled period, with no cap — every recording made during that window gets queued.
- For a long disabled period (the test-instance use case this toggle exists for), this means flipping the toggle back on can trigger downloading days or weeks of accumulated footage across every camera in one batch.
- The codebase already has a bounded "grab the last N recordings per camera" mechanism for fresh installs: `_queue_initial_downloads()` → `_queue_recent(entry_id, host, channel, count=INIT_RECORDINGS_PER_CAMERA)`, where `INIT_RECORDINGS_PER_CAMERA = 2` and `INIT_LOOKBACK_DAYS = 30`.

## Design

### New method: `_resume_recent_downloads()`

Runs only on the disabled → enabled transition. For each loaded Reolink config entry, for each channel with replay capability (same enumeration pattern as `_check_all_channels`):

1. Fast-forward `self._last_check[key]` to "now" and persist it via `self._db.upsert_last_check(key, now.isoformat())`. This prevents the next regular poll from *also* trying to backfill the entire disabled gap on top of what this method just queued.
2. Call the existing `self._queue_recent(entry_id, host, channel, count=INIT_RECORDINGS_PER_CAMERA)` — same method, same constant, as the fresh-install seed.

```python
async def _resume_recent_downloads(self) -> None:
    """On re-enable, skip the historical backlog: queue only the most
    recent INIT_RECORDINGS_PER_CAMERA recordings per camera (same as a
    fresh install), and fast-forward the poll cursor so the next regular
    poll doesn't also try to backfill the whole disabled gap.
    """
    for config_entry in self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
        try:
            host = config_entry.runtime_data.host
        except AttributeError:
            continue
        for channel in host.api.channels:
            if not self._channel_has_replay(host, channel):
                continue
            key = f"{config_entry.entry_id}_{channel}"
            now = self._camera_now(host)
            self._last_check[key] = now
            await self._db.upsert_last_check(key, now.isoformat())
            await self._queue_recent(
                config_entry.entry_id, host, channel, count=INIT_RECORDINGS_PER_CAMERA
            )
```

### `async_set_download_config` changes

Detect the transition by comparing against the prior value before overwriting it:

```python
async def async_set_download_config(self, download_enabled: bool) -> None:
    """Persist new download setting and drain queue if disabling."""
    was_enabled = self._download_enabled
    self._download_enabled = download_enabled
    if not download_enabled:
        # existing drain-queue logic (unchanged)
        ...
    elif not was_enabled:
        await self._resume_recent_downloads()
    await self._download_config_store.async_save({"download_enabled": download_enabled})
```

The `not was_enabled` guard means this only fires on an actual off→on transition. A redundant "enable when already enabled" call does nothing extra (no re-seeding, no cursor fast-forward).

## Behavior Summary

| Transition | Effect |
|---|---|
| enabled → disabled | Queue drained (existing); in-flight download completes (existing); poll cursor freezes (existing fix) |
| disabled → enabled | Poll cursor fast-forwards to now; last `INIT_RECORDINGS_PER_CAMERA` (2) recordings per camera queued; **no backfill of the disabled-period backlog beyond that** |
| enabled → enabled (no-op call) | Nothing happens beyond persisting the flag |

## Files Changed

| File | Change |
|---|---|
| `coordinator.py` | Add `_resume_recent_downloads()`; modify `async_set_download_config` to detect the transition and call it |

No frontend changes — the existing toggle UI and WebSocket commands are unaffected.
