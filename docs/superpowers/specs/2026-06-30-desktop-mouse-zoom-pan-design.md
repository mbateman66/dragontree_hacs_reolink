# Design: Desktop Mouse Zoom/Pan

**Date:** 2026-06-30
**Status:** Approved

---

## Overview

Extends the existing touch pinch-to-zoom feature (PlayerMixin, [2026-06-29-pinch-zoom-download-toggle-design.md](2026-06-29-pinch-zoom-download-toggle-design.md)) to desktop browsers (Windows/Mac) via mouse wheel zoom and click-drag pan. Reuses all existing zoom/pan state and helpers without modification.

## Scope

Applies to both `DragontreeReolinkPlayback` and `DragontreeReolinkLiveCard`, both via the shared `PlayerMixin` — same as touch.

## Reused Infrastructure (unchanged)

- `this._pinch = { scale, tx, ty }` state
- `_clampTranslate(tx, ty, scale, w, h)` — edge-clamping helper
- `_applyZoom()` — applies transform to `querySelector('video, ha-camera-stream')`
- `_resetZoom()` — resets state and clears transform

## New PlayerMixin Method: `_initMouseZoom()`

Called once from `_bindPlayerButtons()`, alongside the existing `_initPinchZoom()` call. Attaches listeners to `videoArea` (wheel, mousedown, dblclick) and to `window` (mousemove, mouseup — so a drag continues even if the cursor leaves the panel).

### Wheel Zoom (toward cursor)

`wheel` listener on `videoArea`, registered with `{ passive: false }`. Always calls `preventDefault()` to stop page scroll.

Per wheel tick:
```
factor = deltaY < 0 ? (1 / 0.9) : 0.9
newScale = clamp(currentScale * factor, 1, 6)
```

Focal point computed identically to the pinch path — cursor position relative to `videoArea`, converted to content space:
```
cursorX, cursorY = mouse position - videoArea rect offset
focalX = (cursorX - tx) / scale
focalY = (cursorY - ty) / scale
newTx = cursorX - focalX * newScale
newTy = cursorY - focalY * newScale
```
Then `_clampTranslate(newTx, newTy, newScale, rect.width, rect.height)`, update `this._pinch`, call `_applyZoom()`.

This recomputes the focal point fresh on every wheel tick (no persisted gesture-start state needed, unlike pinch) — each tick is a small independent step, not a continuous tracked gesture.

### Click-Drag Pan (only when `scale > 1`)

`mousedown` on `videoArea`:
- If `this._pinch.scale <= 1`: no-op (do not start a pan).
- Else: record `this._panStart = { x: cursorX, y: cursorY, tx: this._pinch.tx, ty: this._pinch.ty }` (same shape as the touch pan start) and set `videoArea.style.cursor = 'grabbing'`.

`mousemove` on `window`:
- No-op unless `this._panStart` is set.
- Compute new `tx`/`ty` from `_panStart` + cursor delta, clamp via `_clampTranslate`, update `this._pinch`, call `_applyZoom()`.

`mouseup` on `window`:
- Clear `this._panStart = null`.
- Reset cursor: `grab` if still zoomed in (`scale > 1`), otherwise unset (`''`).

### Cursor Feedback

Cursor style is driven by zoom state, not a new CSS class — set inline on `videoArea.style.cursor`:
- `scale === 1`: unset (default arrow)
- `scale > 1`, not dragging: `grab`
- `scale > 1`, dragging: `grabbing`

Cursor is updated at the same points `_applyZoom()` is called for a scale change (wheel) and at `mousedown`/`mouseup` (drag start/end). `_resetZoom()` also clears the cursor back to default.

### Double-Click Reset

`dblclick` listener on `videoArea` calls `this._resetZoom()` — mirrors the existing double-tap-to-reset behavior on touch.

## Files Changed

| File | Change |
|---|---|
| `js/dragontree-reolink-cards.js` | Add `_initMouseZoom()` to `PlayerMixin`; call it from `_bindPlayerButtons()` alongside `_initPinchZoom()` |

No backend changes. No changes to existing pinch-zoom code from the prior feature.
