# Resume Downloads — Last N Per Camera Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When background downloads are re-enabled after being disabled, queue only the most recent `INIT_RECORDINGS_PER_CAMERA` recordings per camera (same as the fresh-install seed) instead of backfilling the entire disabled-period gap.

**Architecture:** Add a new coordinator method `_resume_recent_downloads()` that fast-forwards the poll cursor (`_last_check`) to "now" and queues recent recordings per channel, reusing the existing `_queue_recent` helper. Call it from `async_set_download_config` only on the disabled→enabled transition, detected by comparing against the prior value before overwriting `self._download_enabled`.

**Tech Stack:** Python 3.12, Home Assistant coordinator pattern

## Global Constraints

- No test framework exists — verification is manual via desktop browser + HA WS devtools + logs
- File touched: `coordinator.py` only — no frontend or `api.py` changes
- Deploy by syncing to the mounted HA config: `cp coordinator.py /mnt/ha-dev/config/custom_components/dragontree_reolink/coordinator.py`
- Backend change requires `ha core restart` on the dev HA instance to take effect
- Reuse the exact existing constant `INIT_RECORDINGS_PER_CAMERA` (= 2) from `const.py` — already imported in `coordinator.py` (line 42) — do not introduce a new constant
- The `not was_enabled` guard must mean a redundant "enable when already enabled" call does nothing extra (no re-seeding, no cursor fast-forward)

---

## Task 1: `_resume_recent_downloads()` and wiring into `async_set_download_config`

**Files:**
- Modify: `coordinator.py:1024-1041` (`async_set_download_config`)
- Modify: `coordinator.py` — insert new method `_resume_recent_downloads()` near the other per-channel sweep methods (after `_queue_initial_downloads`, which ends around line 532 — confirm with `grep -n "_queue_initial_downloads\|_queue_recent" coordinator.py` since line numbers may have shifted)

**Interfaces:**
- Consumes: `self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN)`, `self._channel_has_replay(host, channel)` (static method), `self._camera_now(host)`, `self._db.upsert_last_check(key, iso_str)`, `self._queue_recent(entry_id, host, channel, count)` — all pre-existing, used identically to `_check_all_channels`/`_queue_initial_downloads`
- Produces: `ReolinkDownloadCoordinator._resume_recent_downloads() -> None` — called by `async_set_download_config`

- [ ] **Step 1: Add `_resume_recent_downloads()` to the coordinator**

In `coordinator.py`, find `_queue_initial_downloads` (search `grep -n "async def _queue_initial_downloads" coordinator.py`) and insert this new method immediately after it ends (after its closing, before the next method definition — use `_queue_recent`'s definition as the boundary marker, the new method goes between `_queue_initial_downloads` and `_queue_recent`):

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

- [ ] **Step 2: Wire it into `async_set_download_config`**

Replace the existing `async_set_download_config` method (currently lines 1024-1041 — confirm current location with `grep -n "async def async_set_download_config" coordinator.py`):

```python
    async def async_set_download_config(self, download_enabled: bool) -> None:
        """Persist new download setting and drain queue if disabling."""
        was_enabled = self._download_enabled
        self._download_enabled = download_enabled
        if not download_enabled:
            drained = 0
            while not self._queue.empty():
                try:
                    *_, file_path = self._queue.get_nowait()
                    self._queue.task_done()
                    self._queued_paths.discard(file_path)
                    self._pending_meta.pop(file_path, None)
                    drained += 1
                except asyncio.QueueEmpty:
                    break
            if drained:
                self._notify_sensors()
                self.hass.bus.async_fire(EVENT_QUEUE_CHANGED)
        elif not was_enabled:
            await self._resume_recent_downloads()
        await self._download_config_store.async_save({"download_enabled": download_enabled})
```

(Only the `was_enabled = self._download_enabled` line at the top and the new `elif not was_enabled: await self._resume_recent_downloads()` branch are new — the drain-queue `if not download_enabled:` block and the final store save are unchanged from the existing method.)

- [ ] **Step 3: Verify Python syntax**

```bash
python3 -c "import ast; ast.parse(open('coordinator.py').read()); print('OK')"
```
Expected: `OK`

- [ ] **Step 4: Deploy and verify on the dev HA instance**

```bash
cp coordinator.py /mnt/ha-dev/config/custom_components/dragontree_reolink/coordinator.py
```

SSH to the dev HA instance and restart core, then check logs for errors:
```bash
ha core restart
ha-logs | grep -i "reolink\|error\|traceback" | tail -30
```
Expected: no import errors, no tracebacks, integration loads normally.

Manual verification via the Config tab toggle:
1. Toggle downloads **off**. Confirm the download queue sensor drops to 0 (existing behavior).
2. Wait at least a few minutes so some "missed" recordings would have accumulated on the camera(s) during the disabled window.
3. Toggle downloads **on**. Within one poll cycle (`POLL_INTERVAL` = 15s), confirm the download queue sensor shows at most `INIT_RECORDINGS_PER_CAMERA` (2) new items per camera — not a large backlog covering the entire disabled period.
4. Check `ha-logs` for `_resume_recent_downloads`-triggered activity (the `_queue_recent` calls log `"ch%s '%s': %d recording day(s) found"` — confirm this appears once per camera channel right after toggling on).
5. Toggle downloads **on** again while already on (e.g. click off then immediately back on in the UI, or re-send the same WS command twice) — confirm no duplicate seeding occurs (the `not was_enabled` guard should make the second "on" a no-op beyond persisting the flag).

- [ ] **Step 5: Commit**

```bash
git add coordinator.py
git commit -m "feat: resume downloads queues last N per camera instead of full backlog"
```
