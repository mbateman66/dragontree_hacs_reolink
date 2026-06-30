# Desktop Mouse Zoom/Pan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mouse wheel zoom (toward cursor) and click-drag pan (when zoomed in) to the video player on desktop browsers, reusing the existing touch pinch-zoom state and helpers.

**Architecture:** A single new `PlayerMixin` method, `_initMouseZoom()`, attaches `wheel`/`mousedown`/`dblclick` listeners to `videoArea` and `mousemove`/`mouseup` listeners to `window`. It reads and writes the same `this._pinch` state and calls the same `_clampTranslate`/`_applyZoom`/`_resetZoom` helpers that the touch handler (`_initPinchZoom`, already implemented) uses. No new state shape, no backend changes.

**Tech Stack:** Vanilla JS (Shadow DOM, mouse events)

## Global Constraints

- No test framework exists — verification is manual via desktop browser (Chrome/Safari/Firefox on Mac, or Chrome/Edge on Windows)
- JS lives in a single file: `js/dragontree-reolink-cards.js`
- Deploy by syncing to the mounted HA config: `cp js/dragontree-reolink-cards.js /mnt/ha-dev/config/custom_components/dragontree_reolink/js/`
- After JS-only changes, hard-refresh the browser (Ctrl+Shift+R / Cmd+Shift+R) — no HA restart needed
- Scale clamped to `[1, 6]` (same range as touch pinch)
- Click-drag pan only activates when `this._pinch.scale > 1` — does nothing at scale 1
- Wheel zoom must call `preventDefault()` to stop page scroll
- `mousemove`/`mouseup` listeners go on `window`, not `videoArea`, so a drag continues even if the cursor leaves the panel mid-drag

---

## Task 1: `_initMouseZoom()` — wheel zoom, click-drag pan, double-click reset

**Files:**
- Modify: `js/dragontree-reolink-cards.js` (PlayerMixin: insert new method, wire into `_bindPlayerButtons`)

**Interfaces:**
- Consumes: `this._pinch` (`{scale, tx, ty}`), `this._panStart` (reused from touch — same shape: `{x, y, tx, ty}`), `this._clampTranslate(tx, ty, scale, w, h)`, `this._applyZoom()`, `this._resetZoom()` — all already implemented in PlayerMixin
- Produces: `PlayerMixin._initMouseZoom()` — call once from `_bindPlayerButtons()`

- [ ] **Step 1: Add `_initMouseZoom()` to PlayerMixin**

In `js/dragontree-reolink-cards.js`, insert this new method into `PlayerMixin` immediately after `_initPinchZoom` ends and before `_escHtml` (currently lines 396–397 — confirm with `grep -n "_escHtml" js/dragontree-reolink-cards.js` since line numbers shift as the file grows):

```js
  _initMouseZoom() {
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;

    videoArea.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = videoArea.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const { scale, tx, ty } = this._pinch;
      const factor = e.deltaY < 0 ? (1 / 0.9) : 0.9;
      const newScale = Math.max(1, Math.min(6, scale * factor));
      const focalX = (cursorX - tx) / scale;
      const focalY = (cursorY - ty) / scale;
      const raw = this._clampTranslate(
        cursorX - focalX * newScale,
        cursorY - focalY * newScale,
        newScale, rect.width, rect.height
      );
      this._pinch = { scale: newScale, tx: raw.tx, ty: raw.ty };
      this._applyZoom();
      videoArea.style.cursor = newScale > 1 ? 'grab' : '';
    }, { passive: false });

    videoArea.addEventListener('mousedown', (e) => {
      if (this._pinch.scale <= 1) return;
      const rect = videoArea.getBoundingClientRect();
      this._panStart = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        tx: this._pinch.tx,
        ty: this._pinch.ty,
      };
      videoArea.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._panStart) return;
      const rect = videoArea.getBoundingClientRect();
      const raw = this._clampTranslate(
        this._panStart.tx + (e.clientX - rect.left - this._panStart.x),
        this._panStart.ty + (e.clientY - rect.top  - this._panStart.y),
        this._pinch.scale, rect.width, rect.height
      );
      this._pinch.tx = raw.tx;
      this._pinch.ty = raw.ty;
      this._applyZoom();
    });

    window.addEventListener('mouseup', () => {
      if (!this._panStart) return;
      this._panStart = null;
      videoArea.style.cursor = this._pinch.scale > 1 ? 'grab' : '';
    });

    videoArea.addEventListener('dblclick', () => this._resetZoom());
  },
```

- [ ] **Step 2: Call `_initMouseZoom()` from `_bindPlayerButtons()`**

In `_bindPlayerButtons()` (currently lines 250–259), add the call alongside the existing `_initPinchZoom()` call:

```js
  _bindPlayerButtons() {
    const sr = this.shadowRoot;
    sr.getElementById('btnMute').addEventListener('click', () => this._toggleMute());
    sr.getElementById('btnFullscreen').addEventListener('click', () => this._toggleFullscreen());
    sr.getElementById('playerPanel').addEventListener('fullscreenchange', () => {
      this._updateFullscreenButton();
      if (!document.fullscreenElement) this._resetZoom();
    });
    this._initPinchZoom();
    this._initMouseZoom();
  },
```

- [ ] **Step 3: Clear cursor in `_resetZoom()`**

`_resetZoom()` currently resets `this._pinch`, `this._pinchGesture`, `this._panStart`, and clears the target's transform, but does not touch `videoArea.style.cursor`. Since double-click and video-reload reset paths both call `_resetZoom()`, add a cursor reset there so the cursor doesn't get stuck on `grab`/`grabbing` after a reset. Find the existing `_resetZoom()` method (search `grep -n "_resetZoom()" js/dragontree-reolink-cards.js` for the definition, not the call sites) and add one line:

```js
  _resetZoom() {
    this._pinch = { scale: 1, tx: 0, ty: 0 };
    this._pinchGesture = null;
    this._panStart = null;
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    videoArea.style.cursor = '';
    const target = videoArea.querySelector('video, ha-camera-stream');
    if (target) target.style.transform = '';
  },
```

(Only the `videoArea.style.cursor = '';` line is new — everything else matches the existing method exactly. Do not change the early-return guard `if (!videoArea) return;`; the new line goes after the guard, which is why it's been moved before the `querySelector` call instead of after it.)

- [ ] **Step 4: Deploy and verify on desktop**

```bash
cp js/dragontree-reolink-cards.js /mnt/ha-dev/config/custom_components/dragontree_reolink/js/
```

Hard-refresh the HA frontend on a desktop browser (Mac or Windows). Open a recording in playback view:
1. Scroll wheel up over a point in the video → zooms in, that point stays under the cursor
2. Scroll wheel down → zooms back out, clamped at 1×
3. While zoomed in, cursor shows `grab` over the video
4. Click and drag → video pans; cursor shows `grabbing` while dragging; edges cannot be dragged past the screen boundary
5. Drag the mouse outside the player panel while still holding the button → pan continues to track (does not stop at the panel edge)
6. Release the mouse button anywhere → pan stops, cursor returns to `grab`
7. Double-click → zoom resets to 1×, cursor returns to default
8. At scale 1×, click and drag → nothing happens (no pan, no cursor change)
9. Repeat on the live view card

- [ ] **Step 5: Commit**

```bash
git add js/dragontree-reolink-cards.js
git commit -m "feat: add mouse wheel zoom and click-drag pan for desktop"
```
