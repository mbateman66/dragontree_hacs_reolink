# Pinch-to-Zoom & Download Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pinch-to-zoom gesture support to the video player on iOS/iPad, and add a persistent toggle on the Config tab to disable background video downloads from the Reolink hub.

**Architecture:** Pinch-to-zoom is purely frontend — touch listeners on `.video-area` apply CSS `transform: translate/scale` to the content element (either `<video>` for playback or `ha-camera-stream` for live). Download toggle is backend state (`_download_enabled`) persisted to a dedicated HA `Store`, exposed via two new WebSocket commands, and surfaced as a checkbox in the existing timers card.

**Tech Stack:** Vanilla JS (Shadow DOM, touch events), Python 3.12, Home Assistant WebSocket API, HA `helpers.storage.Store`

## Global Constraints

- No test framework exists — verification is manual via the HA frontend
- JS lives in a single file: `js/dragontree-reolink-cards.js`
- Deploy by syncing to the mounted HA config: `cp /home/mdb/dev/dragontree_reolink/js/dragontree-reolink-cards.js /mnt/ha-dev/config/custom_components/dragontree_reolink/js/`
- After backend changes, restart HA dev instance (SSH to `.50`, run `ha core restart`) and check logs
- After JS-only changes, hard-refresh the browser (Ctrl+Shift+R / Cmd+Shift+R) — no HA restart needed
- All git work in `/home/mdb/dev/dragontree_reolink/`
- `LIVE_STYLE` is defined as `const LIVE_STYLE = PLAYER_STYLE + \`...\`` — CSS changes to `PLAYER_STYLE` automatically apply to live card too

---

## File Map

| File | Tasks | What changes |
|---|---|---|
| `js/dragontree-reolink-cards.js` | 1, 2, 5 | PlayerMixin: CSS, state, helpers, touch handler; timers card: template + logic |
| `coordinator.py` | 3 | `_download_enabled` state, store, `_maybe_enqueue` guard, two new methods |
| `api.py` | 4 | Two new WS commands + registration |

---

## Task 1: Pinch-zoom CSS and PlayerMixin helpers

**Files:**
- Modify: `js/dragontree-reolink-cards.js` (lines 85–90, 239–296)

**Interfaces:**
- Produces: `PlayerMixin._clampTranslate(tx, ty, scale, w, h)`, `PlayerMixin._applyZoom()`, `PlayerMixin._resetZoom()`, `PlayerMixin._initPlayer()` initializes `this._pinch`, `this._lastTap`, `this._pinchGesture`, `this._panStart`

- [ ] **Step 1: Add `overflow: hidden` to `.video-area` in `PLAYER_STYLE`**

In `js/dragontree-reolink-cards.js`, find the `.video-area` rule at line 85 and add `overflow: hidden`:

```js
  /* Video area fills remaining panel height on desktop */
  .video-area {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #000;
    overflow: hidden;
  }
```

- [ ] **Step 2: Add pinch state to `_initPlayer()`**

Replace the existing `_initPlayer()` body (lines 240–243):

```js
  _initPlayer() {
    this._fakeFullscreen = false;
    const s = localStorage.getItem('dragontree_reolink_muted');
    this._muted = s === null ? true : s === 'true';
    this._pinch = { scale: 1, tx: 0, ty: 0 };
    this._lastTap = 0;
    this._pinchGesture = null;
    this._panStart = null;
  },
```

- [ ] **Step 3: Add helper methods to `PlayerMixin` before `_escHtml`**

Insert three new methods into `PlayerMixin` between `_updateFullscreenButton` and `_escHtml` (after line 289, before line 290):

```js
  _clampTranslate(tx, ty, scale, w, h) {
    return {
      tx: Math.max(-(scale - 1) * w, Math.min(0, tx)),
      ty: Math.max(-(scale - 1) * h, Math.min(0, ty)),
    };
  },
  _applyZoom() {
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    const target = videoArea.querySelector('video, ha-camera-stream');
    if (!target) return;
    const { scale, tx, ty } = this._pinch;
    target.style.transformOrigin = '0 0';
    target.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
  },
  _resetZoom() {
    this._pinch = { scale: 1, tx: 0, ty: 0 };
    this._pinchGesture = null;
    this._panStart = null;
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    const target = videoArea.querySelector('video, ha-camera-stream');
    if (target) target.style.transform = '';
  },
```

- [ ] **Step 4: Deploy and verify helpers exist**

```bash
cp /home/mdb/dev/dragontree_reolink/js/dragontree-reolink-cards.js \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/js/
```

Open browser devtools console on the HA playback view. Hard-refresh. Run:
```js
document.querySelector('dragontree-reolink-playback').shadowRoot
  .getElementById('videoArea').style.overflow
```
Expected: `"hidden"`

- [ ] **Step 5: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "feat: add pinch-zoom CSS and PlayerMixin helpers"
```

---

## Task 2: Touch handler + wiring

**Files:**
- Modify: `js/dragontree-reolink-cards.js` (PlayerMixin, `_playUrl`, live card `_startStream`/`_stopLive`)

**Interfaces:**
- Consumes: `this._pinch`, `this._lastTap`, `this._pinchGesture`, `this._panStart` (from Task 1); `this._clampTranslate`, `this._applyZoom`, `this._resetZoom` (from Task 1)
- Produces: `PlayerMixin._initPinchZoom()` — call once from `_bindPlayerButtons()`

- [ ] **Step 1: Add `_initPinchZoom()` to PlayerMixin**

Insert after `_resetZoom` (before `_escHtml`):

```js
  _initPinchZoom() {
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;

    videoArea.addEventListener('touchstart', (e) => {
      const rect = videoArea.getBoundingClientRect();
      if (e.touches.length === 2) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const startDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
        const { scale, tx, ty } = this._pinch;
        this._panStart = null;
        this._pinchGesture = {
          startDist,
          startScale: scale,
          focalX: scale > 0 ? (midX - tx) / scale : midX,
          focalY: scale > 0 ? (midY - ty) / scale : midY,
        };
      } else if (e.touches.length === 1) {
        const touch = e.touches[0];
        const now = Date.now();
        if (now - this._lastTap < 300) {
          this._resetZoom();
        }
        this._lastTap = now;
        if (this._pinch.scale > 1) {
          this._panStart = {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top,
            tx: this._pinch.tx,
            ty: this._pinch.ty,
          };
        }
      }
    }, { passive: false });

    videoArea.addEventListener('touchmove', (e) => {
      const rect = videoArea.getBoundingClientRect();
      if (e.touches.length === 2 && this._pinchGesture) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
        const { startDist, startScale, focalX, focalY } = this._pinchGesture;
        const newScale = Math.max(1, Math.min(6, startScale * (newDist / startDist)));
        const raw = this._clampTranslate(
          midX - focalX * newScale,
          midY - focalY * newScale,
          newScale, rect.width, rect.height
        );
        this._pinch = { scale: newScale, tx: raw.tx, ty: raw.ty };
        this._applyZoom();
      } else if (e.touches.length === 1 && this._panStart) {
        e.preventDefault();
        const touch = e.touches[0];
        const raw = this._clampTranslate(
          this._panStart.tx + (touch.clientX - rect.left - this._panStart.x),
          this._panStart.ty + (touch.clientY - rect.top  - this._panStart.y),
          this._pinch.scale, rect.width, rect.height
        );
        this._pinch.tx = raw.tx;
        this._pinch.ty = raw.ty;
        this._applyZoom();
      }
    }, { passive: false });

    videoArea.addEventListener('touchend', () => {
      this._pinchGesture = null;
      this._panStart = null;
    }, { passive: true });
  },
```

- [ ] **Step 2: Wire `_initPinchZoom` into `_bindPlayerButtons` and reset on fullscreen exit**

Replace the existing `_bindPlayerButtons` and `_toggleFullscreen` in PlayerMixin:

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
  },
  _toggleFullscreen() {
    const panel = this.shadowRoot.getElementById('playerPanel');
    if (!panel) return;
    if (document.fullscreenElement || this._fakeFullscreen) {
      if (document.fullscreenElement) document.exitFullscreen();
      if (this._fakeFullscreen) {
        this._fakeFullscreen = false;
        panel.classList.remove('fake-fullscreen');
        this._updateFullscreenButton();
        this._resetZoom();
      }
    } else if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(() => {
        this._fakeFullscreen = true;
        panel.classList.add('fake-fullscreen');
        this._updateFullscreenButton();
      });
    } else {
      this._fakeFullscreen = true;
      panel.classList.add('fake-fullscreen');
      this._updateFullscreenButton();
    }
  },
```

- [ ] **Step 3: Reset zoom when a new video loads in the playback card**

In `_playUrl()` (around line 1088), add `this._resetZoom()` before `videoArea.innerHTML`:

```js
  _playUrl(url) {
    this._currentUrl = url;
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    this._resetZoom();
    videoArea.innerHTML = `<video autoplay playsinline src="${url}"></video>`;
    // ... rest unchanged
```

Also in the `catch` block in `_selectRecording` (around line 1078), add `this._resetZoom()` before setting error innerHTML:

```js
      } catch (e) {
        console.error('[reolink] Failed to resolve media URL for', rec.content_id, e);
        const videoArea = this.shadowRoot.getElementById('videoArea');
        this._resetZoom();
        if (videoArea) videoArea.innerHTML = `<div class="no-selection">Could not load video</div>`;
      }
```

- [ ] **Step 4: Reset zoom in live card when stream starts or stops**

In `DragontreeReolinkLiveCard._startStream()` (around line 2265), add `this._resetZoom()` before `videoArea.innerHTML = ''`:

```js
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (videoArea) {
      this._resetZoom();
      videoArea.innerHTML = '';
      const streamEl = document.createElement('ha-camera-stream');
      // ... rest unchanged
```

In `_stopLive()` (around line 2295), add `this._resetZoom()` before clearing videoArea:

```js
    const videoArea = this.shadowRoot.getElementById('videoArea');
    this._resetZoom();
    if (videoArea) {
      if (this._selectedCamera) {
        videoArea.innerHTML = `
          <div class="paused-overlay">
          // ... rest unchanged
```

- [ ] **Step 5: Deploy and verify on iPhone/iPad**

```bash
cp /home/mdb/dev/dragontree_reolink/js/dragontree-reolink-cards.js \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/js/
```

Hard-refresh the HA frontend on iOS. Open a recording in playback view:
1. Two-finger pinch open → video zooms in
2. One-finger drag while zoomed → video pans; edges cannot be dragged past screen boundary
3. Double-tap → zoom resets to 1×
4. Navigate to next recording → zoom resets
5. Enter fullscreen, pinch to zoom, exit fullscreen → zoom resets

- [ ] **Step 6: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "feat: add pinch-to-zoom and pan gesture to video player"
```

---

## Task 3: Coordinator download config

**Files:**
- Modify: `coordinator.py`

**Interfaces:**
- Produces:
  - `ReolinkCoordinator._download_enabled: bool`
  - `ReolinkCoordinator.async_get_download_config() -> dict`  — returns `{"download_enabled": bool}`
  - `ReolinkCoordinator.async_set_download_config(download_enabled: bool) -> None`

- [ ] **Step 1: Add `_download_enabled` and store to `__init__`**

In `coordinator.py`, after the existing timer config block (around line 206–208), add:

```python
        # Download enable/disable (loaded from persistent store)
        self._download_config_store: Store | None = None
        self._download_enabled: bool = True
```

- [ ] **Step 2: Load download config in `async_initialize`**

In `async_initialize` (around line 265–268, after timer config is loaded), add:

```python
        # Load download enabled/disabled setting
        self._download_config_store = Store(self.hass, 1, f"{DOMAIN}_download_config")
        dl_cfg = await self._download_config_store.async_load() or {}
        self._download_enabled = dl_cfg.get("download_enabled", True)
```

- [ ] **Step 3: Guard `_maybe_enqueue`**

At the very top of `_maybe_enqueue` (line 582, before any other logic), add:

```python
    async def _maybe_enqueue(
        self, host: Any, channel: int, entry_id: str, vod_file: Any,
        channel_key: str | None = None,
    ) -> bool:
        """Enqueue a VOD file for download if not already tracked/queued/on disk."""
        if not self._download_enabled:
            return False
        is_hub = getattr(host.api, "is_hub", False)
        # ... rest unchanged
```

- [ ] **Step 4: Add `async_get_download_config` and `async_set_download_config`**

After `async_set_timer_config` (around line 992), add:

```python
    def async_get_download_config(self) -> dict:
        """Return the current download enabled/disabled setting."""
        return {"download_enabled": self._download_enabled}

    async def async_set_download_config(self, download_enabled: bool) -> None:
        """Persist new download setting and drain queue if disabling."""
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
        await self._download_config_store.async_save({"download_enabled": download_enabled})
```

- [ ] **Step 5: Deploy backend and verify**

```bash
cp /home/mdb/dev/dragontree_reolink/coordinator.py \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/coordinator.py
```

SSH to dev HA (`.50`) and restart core:
```bash
ha core restart
```

Wait ~30 seconds, then check logs for errors:
```bash
ha-logs | grep -i "reolink\|error\|traceback" | tail -30
```

Expected: no import errors, no tracebacks, integration loads normally.

- [ ] **Step 6: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add coordinator.py
git -C /home/mdb/dev/dragontree_reolink commit -m "feat: add download_enabled config to coordinator"
```

---

## Task 4: WebSocket API for download config

**Files:**
- Modify: `api.py`

**Interfaces:**
- Consumes: `coordinator.async_get_download_config()`, `coordinator.async_set_download_config(bool)` (from Task 3)
- Produces: WS command `dragontree_reolink/get_download_config` → `{"download_enabled": bool}`; WS command `dragontree_reolink/set_download_config` with `{"download_enabled": bool}` → `{}`

- [ ] **Step 1: Register the two new commands**

In `api.py`, extend `async_register_ws_commands` to register both new commands after the existing registrations (line 46):

```python
def async_register_ws_commands(hass: HomeAssistant) -> None:
    """Register WebSocket API commands (idempotent)."""
    websocket_api.async_register_command(hass, ws_get_recordings)
    websocket_api.async_register_command(hass, ws_get_pending)
    websocket_api.async_register_command(hass, ws_get_cameras)
    websocket_api.async_register_command(hass, ws_get_cameras_config)
    websocket_api.async_register_command(hass, ws_set_camera_in_schedule)
    websocket_api.async_register_command(hass, ws_get_schedule)
    websocket_api.async_register_command(hass, ws_set_schedule)
    websocket_api.async_register_command(hass, ws_get_record_timers)
    websocket_api.async_register_command(hass, ws_get_timer_config)
    websocket_api.async_register_command(hass, ws_set_timer_config)
    websocket_api.async_register_command(hass, ws_get_download_config)
    websocket_api.async_register_command(hass, ws_set_download_config)
```

- [ ] **Step 2: Add `ws_get_download_config`**

Append after `ws_set_timer_config` (after line 281):

```python
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_download_config"}
)
@websocket_api.async_response
async def ws_get_download_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the current download enabled/disabled setting."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return
    connection.send_result(msg["id"], runtime_data.coordinator.async_get_download_config())


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_download_config",
        vol.Required("download_enabled"): bool,
    }
)
@websocket_api.async_response
async def ws_set_download_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Enable or disable background video downloads."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return
    await runtime_data.coordinator.async_set_download_config(msg["download_enabled"])
    connection.send_result(msg["id"], {})
```

- [ ] **Step 3: Deploy and verify WS commands respond**

```bash
cp /home/mdb/dev/dragontree_reolink/api.py \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/api.py
```

Restart HA core (`ha core restart`). Open HA devtools (Settings → Developer Tools → Template). Switch to "WebSocket" tab and send:
```json
{"id": 99, "type": "dragontree_reolink/get_download_config"}
```
Expected response:
```json
{"id": 99, "type": "result", "success": true, "result": {"download_enabled": true}}
```

Then send:
```json
{"id": 100, "type": "dragontree_reolink/set_download_config", "download_enabled": false}
```
Expected: `{"id": 100, "type": "result", "success": true, "result": {}}`

Send `get_download_config` again — expected: `{"download_enabled": false}`

Restart HA core again. Send `get_download_config` — expected: `{"download_enabled": false}` (persisted).

Re-enable: send `set_download_config` with `"download_enabled": true`.

- [ ] **Step 4: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add api.py
git -C /home/mdb/dev/dragontree_reolink commit -m "feat: add get/set_download_config WebSocket commands"
```

---

## Task 5: Download toggle in timers card (frontend)

**Files:**
- Modify: `js/dragontree-reolink-cards.js` (`TIMERS_STYLE`, `TIMERS_TEMPLATE`, `DragontreeReolinkTimersCard`)

**Interfaces:**
- Consumes: WS `dragontree_reolink/get_download_config`, WS `dragontree_reolink/set_download_config` (from Task 4)

- [ ] **Step 1: Add toggle styles to `TIMERS_STYLE`**

In `TIMERS_STYLE` (lines 1720–1756), add these rules before the closing backtick:

```js
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    min-height: 52px;
  }
  .toggle-label { font-size: 1rem; color: var(--primary-text-color); }
  .dl-warning {
    font-size: 0.75rem;
    color: #f9a825;
    padding: 0 16px 8px;
  }
  .dl-warning[hidden] { display: none; }
```

- [ ] **Step 2: Extend `TIMERS_TEMPLATE` with downloads section**

Replace the existing `TIMERS_TEMPLATE` constant:

```js
const TIMERS_TEMPLATE = `
  <style>${TIMERS_STYLE}</style>
  <ha-card header="Default Timers">
    <div class="row">
      <span class="row-label">Live View Timeout</span>
      <div class="input-wrap">
        <input type="text" id="liveTimeout" placeholder="M:SS" maxlength="5">
        <span class="field-error" id="liveErr"></span>
      </div>
    </div>
    <div class="row">
      <span class="row-label">Recording Timeout</span>
      <div class="input-wrap">
        <input type="text" id="recTimeout" placeholder="M:SS" maxlength="5">
        <span class="field-error" id="recErr"></span>
      </div>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Background Downloads</span>
      <ha-switch id="downloadEnabled"></ha-switch>
    </div>
    <div class="dl-warning" id="dlWarning" hidden>Downloads are disabled</div>
    <div class="status-text" id="statusText">Range: 0:15 – 10:00</div>
  </ha-card>
`;
```

- [ ] **Step 3: Extend `_loadConfig` to parallel-load download config**

Replace the existing `_loadConfig` method:

```js
  async _loadConfig() {
    try {
      const [timerResult, dlResult] = await Promise.all([
        this._hass.callWS({ type: 'dragontree_reolink/get_timer_config' }),
        this._hass.callWS({ type: 'dragontree_reolink/get_download_config' }),
      ]);
      this.shadowRoot.getElementById('liveTimeout').value =
        this._secsToMmss(timerResult.live_timeout_secs);
      this.shadowRoot.getElementById('recTimeout').value =
        this._secsToMmss(timerResult.record_timeout_secs);
      const dlSwitch = this.shadowRoot.getElementById('downloadEnabled');
      dlSwitch.checked = dlResult.download_enabled;
      this._updateDlWarning(dlResult.download_enabled);
    } catch (e) {
      console.error('[reolink] Failed to load config:', e);
    }
  }
```

- [ ] **Step 4: Add `_saveDownload`, `_updateDlWarning`, and wire in `_bindEvents`**

Add two new methods to `DragontreeReolinkTimersCard` after `_save`:

```js
  async _saveDownload() {
    const sr = this.shadowRoot;
    const enabled = sr.getElementById('downloadEnabled').checked;
    try {
      await this._hass.callWS({
        type: 'dragontree_reolink/set_download_config',
        download_enabled: enabled,
      });
      this._updateDlWarning(enabled);
      const statusEl = sr.getElementById('statusText');
      if (statusEl) {
        statusEl.textContent = 'Saved.';
        setTimeout(() => { statusEl.textContent = 'Range: 0:15 – 10:00'; }, 2000);
      }
    } catch (e) {
      console.error('[reolink] Failed to save download config:', e);
    }
  }

  _updateDlWarning(enabled) {
    const el = this.shadowRoot.getElementById('dlWarning');
    if (el) el.hidden = enabled;
  }
```

Replace the existing `_bindEvents` method to add the download toggle listener:

```js
  _bindEvents() {
    const sr = this.shadowRoot;
    const onLiveChange = () => this._onFieldChange('liveTimeout', 'liveErr');
    const onRecChange  = () => this._onFieldChange('recTimeout', 'recErr');

    sr.getElementById('liveTimeout').addEventListener('change', onLiveChange);
    sr.getElementById('liveTimeout').addEventListener('blur', onLiveChange);
    sr.getElementById('recTimeout').addEventListener('change', onRecChange);
    sr.getElementById('recTimeout').addEventListener('blur', onRecChange);
    sr.getElementById('downloadEnabled').addEventListener('change', () => this._saveDownload());
  }
```

- [ ] **Step 5: Deploy and verify end-to-end**

```bash
cp /home/mdb/dev/dragontree_reolink/js/dragontree-reolink-cards.js \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/js/
```

Hard-refresh the HA frontend. Navigate to Config tab:
1. "Background Downloads" toggle should be visible in the Default Timers card, checked ON
2. Uncheck it → "Downloads are disabled" amber warning appears; "Saved." flashes briefly
3. Reload the page → toggle still shows unchecked, warning still visible (persisted)
4. Check it back ON → warning disappears

Navigate to Playback tab and trigger an action that would normally queue a recording (e.g., wait for the poll, or check the Download Queue sensor). With downloads disabled, queue depth stays 0.

- [ ] **Step 6: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "feat: add download toggle to timers card"
```
