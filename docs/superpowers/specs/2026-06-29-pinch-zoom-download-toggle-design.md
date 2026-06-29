# Design: Pinch-to-Zoom & Download Toggle

**Date:** 2026-06-29
**Status:** Approved

---

## Overview

Two independent features:

1. **Pinch-to-zoom** — touch gesture support for zooming and panning the video in the fullscreen (and non-fullscreen) player on iOS/iPad.
2. **Download toggle** — a persistent setting on the Config tab that disables background video downloads from the Reolink hub. Useful on test HA instances.

---

## Feature 1: Pinch-to-Zoom

### Scope

Applies to both `DragontreeReolinkPlayback` and `DragontreeReolinkLiveCard`, both of which use the shared `PlayerMixin`.

### CSS Change

Add `overflow: hidden` to `.video-area` in `PLAYER_STYLE` (and `LIVE_STYLE`, which has its own copy). This clips the scaled video at the video-area boundary rather than at the outer player panel (which includes the controls bar).

### PlayerMixin State

Added to `_initPlayer()`:

```js
this._pinch = { scale: 1, tx: 0, ty: 0 };
this._lastTap = 0;
```

### New PlayerMixin Methods

**`_initPinchZoom()`**
Called once from `_bindPlayerButtons()` after the shadow DOM is ready. Attaches `touchstart`, `touchmove`, `touchend` listeners to the `videoArea` element (not the video element itself, so touches on letterbox bars are captured). Listeners survive video element replacement since they're on the container.

**`_applyZoom()`**
Finds the current `<video>` element via `querySelector('video')` and sets:
```js
video.style.transformOrigin = '0 0';
video.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
```
With `transform-origin: 0 0`, the top-left corner of the video element is the reference point.

**`_resetZoom()`**
Resets `this._pinch` to `{ scale: 1, tx: 0, ty: 0 }` and clears the transform on the current video element. Called on: double-tap, video element replacement (resets `_pinch` state; new element already has no transform), fullscreen exit.

**`_clampTranslate(tx, ty, scale, w, h)`**
Constrains translation so no edge can move inside the corresponding container edge:
- `tx` clamped to `[-(scale - 1) * w, 0]`
- `ty` clamped to `[-(scale - 1) * h, 0]`

When `scale = 1` this forces `tx = ty = 0`. When `scale = 2` allows up to one full container-width of translation in each direction.

### Touch Handling

All listeners use `{ passive: false }` to allow `preventDefault()`.

**`touchstart`**
- **1 finger:**
  - Check double-tap: if time since `_lastTap < 300ms`, call `_resetZoom()`.
  - Update `_lastTap = Date.now()`.
  - If `scale > 1`, start pan: record `_panStart = { x, y, tx, ty }`.
- **2 fingers:**
  - Record `startDist` (distance between fingers), `startScale = _pinch.scale`, `startTx = _pinch.tx`, `startTy = _pinch.ty`.
  - Compute focal point in content space: `focalX = (midX - startTx) / startScale`, `focalY = (midY - startTy) / startScale`. This is the point that stays under the fingers' midpoint throughout the gesture.

**`touchmove`**
- Call `preventDefault()` only if 2-finger gesture or actively panning (avoids blocking normal taps when not zoomed).
- **1 finger while panning:**
  ```
  tx = _panStart.tx + (currentX - _panStart.x)
  ty = _panStart.ty + (currentY - _panStart.y)
  ```
  Clamp, then apply.
- **2 fingers:**
  ```
  newScale = clamp(startScale * (newDist / startDist), 1.0, 6.0)
  tx = midX - focalX * newScale
  ty = midY - focalY * newScale
  ```
  Clamp, then apply.

**`touchend`**
Clear active gesture state (`_panStart`, 2-finger tracking vars).

### Reset Triggers

| Event | Action |
|---|---|
| Double-tap on video area | `_resetZoom()` |
| New video loaded (innerHTML replacement) | Reset `_pinch` state (new element has no transform) |
| Fullscreen exit | `_resetZoom()` |

### Zoom Limits

- Minimum: `1.0` (cannot zoom out past natural size)
- Maximum: `6.0` (sufficient to inspect fine detail)

---

## Feature 2: Download Toggle

### Behavior

When downloads are disabled:
- `_maybe_enqueue` returns early — no new items enter the queue.
- Any currently **queued** items are drained (removed without downloading).
- Any **in-flight** download is allowed to complete (avoids partial files on disk).
- Setting persists across HA restarts via a dedicated store.

When re-enabled: the download worker is still running (it blocked on an empty queue), so new items enqueued by the next poll cycle are processed immediately.

### Backend — `coordinator.py`

**New state:**
```python
self._download_enabled: bool = True
self._download_config_store: Store  # f"{DOMAIN}_download_config"
```

**`async_initialize`:** After loading timer config, load download config store:
```python
self._download_config_store = Store(self.hass, 1, f"{DOMAIN}_download_config")
dl_cfg = await self._download_config_store.async_load() or {}
self._download_enabled = dl_cfg.get("download_enabled", True)
```

**`_maybe_enqueue`:** Add at the top of the method:
```python
if not self._download_enabled:
    return False
```

**`async_get_download_config() -> dict`:**
```python
return {"download_enabled": self._download_enabled}
```

**`async_set_download_config(download_enabled: bool) -> None`:**
```python
self._download_enabled = download_enabled
if not download_enabled:
    # Drain queued items; in-flight download completes naturally
    while not self._queue.empty():
        try:
            *_, file_path = self._queue.get_nowait()
            self._queue.task_done()
            self._queued_paths.discard(file_path)
            self._pending_meta.pop(file_path, None)
        except asyncio.QueueEmpty:
            break
    self._notify_sensors()
    self.hass.bus.async_fire(EVENT_QUEUE_CHANGED)
await self._download_config_store.async_save({"download_enabled": download_enabled})
```

### Backend — `api.py`

Two new WS commands registered in `async_register_ws_commands`:

**`ws_get_download_config`**
- Schema: `{vol.Required("type"): f"{DOMAIN}/get_download_config"}`
- Returns: `coordinator.async_get_download_config()`

**`ws_set_download_config`**
- Schema: `{vol.Required("type"): f"{DOMAIN}/set_download_config", vol.Required("download_enabled"): bool}`
- Calls: `await coordinator.async_set_download_config(msg["download_enabled"])`
- Returns: `{}`

### Frontend — Timers Card

**`_loadConfig()`** fires both WS calls in parallel:
```js
const [timerResult, dlResult] = await Promise.all([
    this._hass.callWS({ type: 'dragontree_reolink/get_timer_config' }),
    this._hass.callWS({ type: 'dragontree_reolink/get_download_config' }),
]);
```

**New "Downloads" section** in the timers card HTML template:
- Checkbox `id="downloadEnabled"` with label "Background downloads"
- When unchecked: amber warning text "Downloads are disabled"
- On `change`: call `_saveDownload()` immediately

**`_saveDownload()`:**
```js
async _saveDownload() {
    const enabled = this.shadowRoot.getElementById('downloadEnabled').checked;
    await this._hass.callWS({
        type: 'dragontree_reolink/set_download_config',
        download_enabled: enabled,
    });
    // brief "Saved." flash via statusText element (same pattern as timer save)
}
```

---

## Files Changed

| File | Change |
|---|---|
| `js/dragontree-reolink-cards.js` | `overflow:hidden` on `.video-area` in `PLAYER_STYLE` and `LIVE_STYLE`; add `_initPinchZoom`, `_applyZoom`, `_resetZoom`, `_clampTranslate` to `PlayerMixin`; call `_initPinchZoom()` from `_bindPlayerButtons()`; call `_resetZoom()` on fullscreen exit and video load; extend timers card template and logic with downloads toggle |
| `coordinator.py` | Add `_download_enabled`, `_download_config_store`; extend `async_initialize`; add `_maybe_enqueue` guard; add `async_get_download_config`, `async_set_download_config` |
| `api.py` | Add `ws_get_download_config`, `ws_set_download_config`; register both |
