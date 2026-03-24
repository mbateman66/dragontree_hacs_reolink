/**
 * Dragontree Reolink — custom Lovelace cards
 *
 * Elements defined here:
 *   dragontree-reolink-playback  — 3-panel recording playback UI
 *   dragontree-reolink-schedule  — camera schedule on/off times
 *   dragontree-reolink-cameras   — per-camera enable + schedule toggles
 *   dragontree-reolink-timers    — configurable live-view and recording timeouts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }

/** Format a Date as YYYY-MM-DDTHH:MM:SS in local time (matches DB storage). */
function toLocalIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Format an ISO datetime string as a date only (e.g. "Feb 27"). */
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Format an ISO datetime string as a time only (e.g. "11:02 AM"). */
function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Format duration in seconds as "1m 23s" or "45s". */
function formatDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Format a number of seconds as M:SS (e.g. 83 → "1:23"). Returns '--:--' for non-finite values. */
function fmtVideoTime(s) {
  return isFinite(s) ? `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}` : '--:--';
}

const TIME_DISPLAY_EMPTY = '--:-- / --:--';

/** Parse the triggers JSON stored in the DB into an array of strings. */
function parseTriggers(triggersJson) {
  if (!triggersJson) return [];
  try { return JSON.parse(triggersJson); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Shared player layout CSS and mixin
// ---------------------------------------------------------------------------

const PLAYER_STYLE = `
  :host { display: block; }

  .container {
    display: grid;
    grid-template-columns: 1fr 380px;
    gap: 12px;
    height: 70vh;
    min-height: 420px;
  }

  .player-panel {
    display: flex;
    flex-direction: column;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
    min-height: 0;
  }

  /* Video area fills remaining panel height on desktop */
  .video-area {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #000;
  }

  /* Any direct child of video-area fills it absolutely */
  .video-area > * {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* For <video> specifically */
  .video-area > video {
    object-fit: contain;
    display: block;
  }

  .no-selection, .paused-overlay {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    color: #888;
    font-size: 0.9em;
    text-align: center;
    padding: 24px;
    gap: 8px;
  }

  .paused-overlay ha-icon { --mdc-icon-size: 48px; color: #555; }

  /* Controls bar sits below video, always visible */
  .controls-bar {
    flex-shrink: 0;
    background: #1a1a1a;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .controls-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ctrl-spacer { flex: 1; }

  /* Buttons — dark theme for the controls bar */
  .ctrl-btn {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.22);
    color: #fff;
    padding: 5px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82em;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .ctrl-btn:hover:not([disabled]) { background: rgba(255,255,255,0.25); }
  .ctrl-btn[disabled] { opacity: 0.35; cursor: default; }
  .ctrl-btn.icon-only { padding: 5px; }
  .ctrl-btn.active {
    background: var(--primary-color, #03a9f4);
    border-color: var(--primary-color, #03a9f4);
  }
  .ctrl-btn.danger { background: #c62828; border-color: #c62828; }

  /* Timers */
  .timer {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,0.45);
    min-width: 36px;
    white-space: nowrap;
  }
  .timer.active { color: #fff; }
  .timer.urgent { color: #ef5350; }
  .timer.rec { color: #ef9a9a; }

  /* Seek bar */
  .seek-bar {
    width: 100%;
    accent-color: #fff;
    cursor: pointer;
    height: 4px;
  }
  .seek-bar:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* Right panel */
  .right-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }

  .list-panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--card-background-color, #fff);
    border-radius: 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
  }

  .list-msg {
    padding: 24px;
    text-align: center;
    color: var(--secondary-text-color, #888);
    font-size: 0.88em;
  }

  /* Mobile: stack vertically, video-area is 16:9 block */
  @media (max-width: 800px) {
    .container {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
      height: calc(100dvh - 56px);
      min-height: 400px;
    }
    .video-area {
      flex: none;
      aspect-ratio: 16 / 9;
    }
  }

  /* Fullscreen — player panel fills screen, video-area flexes to fill remaining */
  #playerPanel.fake-fullscreen {
    position: fixed;
    inset: 0;
    z-index: 9999;
    border-radius: 0;
  }
  #playerPanel:fullscreen .video-area,
  #playerPanel.fake-fullscreen .video-area {
    flex: 1;
    aspect-ratio: unset;
  }
`;

const PlayerMixin = {
  _initPlayer() {
    this._fakeFullscreen = false;
    const s = localStorage.getItem('dragontree_reolink_muted');
    this._muted = s === null ? true : s === 'true';
  },
  _bindPlayerButtons() {
    const sr = this.shadowRoot;
    sr.getElementById('btnMute').addEventListener('click', () => this._toggleMute());
    sr.getElementById('btnFullscreen').addEventListener('click', () => this._toggleFullscreen());
    sr.getElementById('playerPanel').addEventListener('fullscreenchange', () => this._updateFullscreenButton());
  },
  _toggleMute() {
    this._muted = !this._muted;
    localStorage.setItem('dragontree_reolink_muted', this._muted);
    this._applyMute();
    this._updateMuteButton();
  },
  _updateMuteButton() {
    const btn = this.shadowRoot.getElementById('btnMute');
    if (!btn) return;
    btn.innerHTML = `<ha-icon icon="${this._muted ? 'mdi:volume-off' : 'mdi:volume-high'}" style="--mdc-icon-size:18px"></ha-icon>`;
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
  _updateFullscreenButton() {
    const btn = this.shadowRoot.getElementById('btnFullscreen');
    if (!btn) return;
    const isFs = !!document.fullscreenElement || this._fakeFullscreen;
    btn.innerHTML = `<ha-icon icon="${isFs ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'}" style="--mdc-icon-size:18px"></ha-icon>`;
  },
  _escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  },
};

// ---------------------------------------------------------------------------
// dragontree-reolink-playback
// ---------------------------------------------------------------------------

const STYLE = PLAYER_STYLE + `
  /* ── Filter ── */
  .filter-panel {
    background: var(--card-background-color, #fff);
    border-radius: 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
    flex-shrink: 0;
  }
  .filter-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
    color: var(--primary-text-color, #212121);
    font-weight: 500;
    font-size: 0.9em;
  }
  .filter-toggle:hover { background: var(--secondary-background-color, #f5f5f5); border-radius: 8px; }
  .arrow { display: inline-block; transition: transform 0.2s; font-size: 0.75em; }
  .filter-toggle.open .arrow { transform: rotate(180deg); }
  .filter-title-group { display: flex; align-items: center; gap: 6px; }
  #filterIcon { --mdc-icon-size: 16px; color: var(--disabled-text-color, #9e9e9e); pointer-events: none; }
  #filterIcon.filters-active { color: var(--primary-color, #03a9f4); cursor: pointer; pointer-events: auto; }
  .filter-body {
    display: none;
    padding: 12px 14px;
    border-top: 1px solid var(--divider-color, #e0e0e0);
    flex-direction: column;
    gap: 12px;
  }
  .filter-body.open { display: flex; }
  .fg-label {
    display: block;
    font-size: 0.75em;
    font-weight: 600;
    color: var(--secondary-text-color, #666);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .checkbox-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .cb-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.84em;
    cursor: pointer;
    color: var(--primary-text-color, #212121);
  }
  /* ── Recording list ── */
  .rec-item {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    gap: 10px;
    transition: background 0.1s;
  }
  .rec-item:last-child { border-bottom: none; }
  .rec-item:hover { background: var(--secondary-background-color, #f5f5f5); }
  .rec-item.selected { background: var(--primary-color-light, #e3f2fd); }
  .rec-info { flex: 1; min-width: 0; }
  .rec-camera {
    font-size: 0.92em;
    font-weight: 500;
    color: var(--primary-text-color, #212121);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rec-time {
    font-size: 0.75em;
    color: var(--secondary-text-color, #888);
    margin-top: 2px;
  }
  .rec-thumb {
    width: 80px;
    height: 45px;
    object-fit: cover;
    border-radius: 3px;
    flex-shrink: 0;
    background: var(--secondary-background-color, #eee);
    display: block;
  }
  .rec-thumb-empty {
    width: 80px;
    height: 45px;
    flex-shrink: 0;
    border-radius: 3px;
    background: var(--secondary-background-color, #eee);
  }
  .rec-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex-shrink: 0;
  }
  .rec-time-of-day {
    font-size: 0.92em;
    font-weight: normal;
    color: var(--primary-text-color, #212121);
    white-space: nowrap;
  }
  .rec-tags { display: flex; gap: 4px; }
  .tag {
    font-size: 0.65em;
    padding: 2px 5px;
    border-radius: 3px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .tag-ANIMAL  { background: #e8f5e9; color: #2e7d32; }
  .tag-VEHICLE { background: #e3f2fd; color: #1565c0; }
  .tag-PERSON  { background: #fff3e0; color: #e65100; }

  /* ── Pending (queued/downloading) items ── */
  .rec-item.pending {
    opacity: 0.45;
    cursor: default;
  }
  .rec-item.pending:hover { background: transparent; }
  .tag-downloading {
    font-size: 0.65em;
    padding: 2px 5px;
    border-radius: 3px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: #f3e5f5;
    color: #6a1b9a;
  }
  .tag-queued {
    font-size: 0.65em;
    padding: 2px 5px;
    border-radius: 3px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: #e8eaf6;
    color: #283593;
  }
  .tag-recording {
    font-size: 0.65em;
    padding: 2px 5px;
    border-radius: 3px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: #fce4ec;
    color: #b71c1c;
  }

  /* ── Load-more footer ── */
  .list-footer {
    text-align: center;
    padding: 12px;
    color: var(--secondary-text-color, #888);
    font-size: 0.8em;
    min-height: 8px;
  }
`;

const TEMPLATE = `
  <style>${STYLE}</style>
  <div class="container">

    <div class="player-panel" id="playerPanel">
      <div class="video-area" id="videoArea">
        <div class="no-selection">Select a recording to play</div>
      </div>
      <div class="controls-bar" id="controlsBar">
        <input type="range" class="seek-bar" id="seekBar" value="0" min="0" max="100" step="0.1">
        <div class="controls-row">
          <button class="ctrl-btn" id="btnPrev" disabled>&#9664; Prev</button>
          <button class="ctrl-btn icon-only" id="btnPlayPause" disabled>
            <ha-icon icon="mdi:play" style="--mdc-icon-size:18px"></ha-icon>
          </button>
          <button class="ctrl-btn" id="btnNext" disabled>Next &#9654;</button>
          <span class="timer" id="timeDisplay">--:-- / --:--</span>
          <div class="ctrl-spacer"></div>
          <button class="ctrl-btn icon-only" id="btnMute">
            <ha-icon icon="mdi:volume-high" style="--mdc-icon-size:18px"></ha-icon>
          </button>
          <button class="ctrl-btn icon-only" id="btnFullscreen">
            <ha-icon icon="mdi:fullscreen" style="--mdc-icon-size:18px"></ha-icon>
          </button>
        </div>
      </div>
    </div>

    <div class="right-panel">
      <div class="filter-panel">
        <div class="filter-toggle" id="filterToggle">
          <span class="filter-title-group">
            <span>Filters</span>
            <ha-icon id="filterIcon" icon="mdi:filter-off"></ha-icon>
          </span>
          <span class="arrow">&#9660;</span>
        </div>
        <div class="filter-body" id="filterBody">
          <div id="cameraGroup">
            <span class="fg-label">Cameras</span>
            <div class="checkbox-group" id="cameraChecks"></div>
          </div>
          <div>
            <span class="fg-label">Tags</span>
            <div class="checkbox-group" id="tagChecks"></div>
          </div>
          <div>
            <span class="fg-label">Options</span>
            <div class="checkbox-group" id="optionChecks"></div>
          </div>
        </div>
      </div>

      <div class="list-panel" id="listPanel">
        <div class="list-msg">Loading…</div>
      </div>
    </div>
  </div>
`;

class DragontreeReolinkPlayback extends HTMLElement {
  static _STORAGE_KEY = 'dragontree_reolink_playback_state';
  static _HA_USER_KEY  = 'dragontree_reolink_filters';
  static _PAGE_SIZE    = 50;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._recordings = [];
    this._pending = [];
    this._cameras = [];
    this._selectedIndex = -1;
    this._filtersOpen = false;
    this._initialized = false;
    this._filters = this._defaultFilters();
    this._thumbCache = new Map(); // content_id → resolved URL
    this._unsubRecordingEvents = null;
    this._pendingPollTimer = null;
    this._hasMore = true;
    this._loadingMore = false;
    this._totalRecEntityId = null;  // sensor.dragontree_reolink_total_recordings
    this._lastTotalRec = null;      // last seen value of the sensor
    this._refreshTimer = null;      // debounce handle
    // PlayerMixin state
    this._initPlayer();
  }

  _saveFilters() {
    const payload = { filters: this._filters, filtersOpen: this._filtersOpen };
    // Fast local cache for instant UI restore
    try {
      sessionStorage.setItem(DragontreeReolinkPlayback._STORAGE_KEY, JSON.stringify(payload));
    } catch { /* sessionStorage unavailable */ }
    // Persistent per-user server storage (fire-and-forget)
    this._hass && this._hass.callWS({
      type: 'frontend/set_user_data',
      key: DragontreeReolinkPlayback._HA_USER_KEY,
      value: payload,
    }).catch(() => {});
  }

  /** Instant restore from sessionStorage (synchronous, used in _build before DOM paints). */
  _restoreFilters() {
    try {
      const raw = sessionStorage.getItem(DragontreeReolinkPlayback._STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.filters) this._filters = { ...this._defaultFilters(), ...saved.filters };
      if (saved.filtersOpen !== undefined) this._filtersOpen = !!saved.filtersOpen;
    } catch { /* ignore corrupt or unavailable storage */ }
  }

  /** Load authoritative filters from HA user data (async, called before first data fetch). */
  async _loadUserFilters() {
    try {
      const result = await this._hass.callWS({
        type: 'frontend/get_user_data',
        key: DragontreeReolinkPlayback._HA_USER_KEY,
      });
      if (!result || !result.value) return;
      const saved = result.value;
      if (saved.filters) this._filters = { ...this._defaultFilters(), ...saved.filters };
      if (saved.filtersOpen !== undefined) this._filtersOpen = !!saved.filtersOpen;
      // Sync the authoritative value back to sessionStorage
      try {
        sessionStorage.setItem(DragontreeReolinkPlayback._STORAGE_KEY, JSON.stringify(saved));
      } catch {}
    } catch { /* HA user data not available, keep sessionStorage values */ }
  }

  _applyFilterPanelState() {
    const sr = this.shadowRoot;
    const toggle = sr.getElementById('filterToggle');
    const body   = sr.getElementById('filterBody');
    if (toggle) toggle.classList.toggle('open', this._filtersOpen);
    if (body)   body.classList.toggle('open', this._filtersOpen);
  }

  _updateFilterIcon() {
    const icon = this.shadowRoot && this.shadowRoot.getElementById('filterIcon');
    if (!icon) return;
    const active = this._filters.cameras.length > 0 || this._filters.triggers.length > 0 || this._filters.hidePending;
    icon.setAttribute('icon', active ? 'mdi:filter' : 'mdi:filter-off');
    icon.classList.toggle('filters-active', active);
  }

  _clearFilters() {
    this._filters = this._defaultFilters();
    this._saveFilters();
    this._renderFilterInputs();
    this._loadRecordings().then(() => this._renderList());
  }

  connectedCallback() {
    if (this._initialized) {
      this._subscribeRecordingEvents();
      this._pollPending();
    }
  }

  disconnectedCallback() {
    if (this._unsubRecordingEvents) {
      this._unsubRecordingEvents();
      this._unsubRecordingEvents = null;
    }
    clearInterval(this._pendingPollTimer);
    this._pendingPollTimer = null;
  }

  // ── Lovelace lifecycle ────────────────────────────────────────────────────

  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
      return;
    }
    // Fallback: detect new downloads by watching total_recordings sensor state.
    // This fires on every HA state push so we check only the one entity we care about.
    if (prev && this._totalRecEntityId) {
      const prevVal = prev.states[this._totalRecEntityId]?.state;
      const nextVal = hass.states[this._totalRecEntityId]?.state;
      if (prevVal !== undefined && nextVal !== undefined && nextVal !== prevVal) {
        this._debouncedRefresh();
      }
    }
  }

  _debouncedRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this._refreshRecordings(), 1000);
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  _build() {
    this.shadowRoot.innerHTML = TEMPLATE;
    this._restoreFilters();        // instant sessionStorage fast-path
    this._bindStaticEvents();
    this._updateMuteButton();
    this._applyFilterPanelState(); // correct open/closed before any async work
    this._renderFilterInputs();

    // Infinite scroll: load more when near the bottom of the list panel
    const listPanel = this.shadowRoot.getElementById('listPanel');
    listPanel.addEventListener('scroll', () => {
      if (this._loadingMore || !this._hasMore) return;
      if (listPanel.scrollTop + listPanel.clientHeight >= listPanel.scrollHeight - 250) {
        this._loadMoreRecordings();
      }
    });

    // Find total_recordings sensor once for the state-change fallback in set hass()
    this._totalRecEntityId = Object.keys(this._hass.states).find(eid =>
      eid.includes('dragontree_reolink') && eid.includes('total_recordings')
    ) || null;

    // Load authoritative user filters first so the first recordings query uses them
    this._loadUserFilters().then(() => {
      this._applyFilterPanelState();
      this._renderFilterInputs();
      return this._loadCameras();
    }).then(() => {
      this._renderFilterInputs();
      return this._loadRecordings();
    }).then(() => {
      this._renderList();
      this._subscribeRecordingEvents();
    });
  }

  // ── Default filter state ──────────────────────────────────────────────────

  _defaultFilters() {
    return {
      cameras: [],    // empty = all cameras
      triggers: [],   // empty = no tag filter
      hidePending: false,
    };
  }

  // ── Live update subscription ──────────────────────────────────────────────

  _subscribeRecordingEvents() {
    if (this._unsubRecordingEvents) return;
    const refresh = () => this._debouncedRefresh();
    Promise.all([
      this._hass.connection.subscribeEvents(refresh, 'dragontree_reolink_recording_added'),
      this._hass.connection.subscribeEvents(refresh, 'dragontree_reolink_queue_changed'),
    ]).then(([unsub1, unsub2]) => {
      this._unsubRecordingEvents = () => { unsub1(); unsub2(); };
    }).catch(err => {
      console.warn('[reolink] Event subscription failed, relying on state fallback:', err);
    });

    if (!this._pendingPollTimer) {
      this._pendingPollTimer = setInterval(() => this._pollPending(), 8000);
    }
  }

  async _pollPending() {
    if (!this._hass) return;
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_pending' });
      const fresh = result.pending || [];
      const changed =
        fresh.length !== this._pending.length ||
        fresh.some((r, i) => r.path !== (this._pending[i] || {}).path || r.status !== (this._pending[i] || {}).status);
      if (changed) {
        this._pending = fresh;
        this._renderList();
      }
    } catch (err) {
      console.warn('[reolink] _pollPending failed:', err);
    }
  }

  async _refreshRecordings() {
    // Preserve the selected recording across the refresh by content_id so that
    // new recordings inserted above/below the current position don't shift it.
    const selectedCid = this._selectedIndex >= 0
      ? (this._recordings[this._selectedIndex] || {}).content_id
      : null;
    await this._loadRecordings();
    if (selectedCid) {
      this._selectedIndex = this._recordings.findIndex(r => r.content_id === selectedCid);
    }
    this._renderList();
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async _loadCameras() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_cameras' });
      this._cameras = result.cameras || [];
    } catch (e) {
      console.error('[reolink] Failed to load cameras:', e);
    }
  }

  async _loadRecordings() {
    this._hasMore = true;
    this._loadingMore = false;
    const msg = {
      type: 'dragontree_reolink/get_recordings',
      sort_desc: true,
      limit: DragontreeReolinkPlayback._PAGE_SIZE,
    };
    if (this._filters.cameras.length) msg.cameras = this._filters.cameras;
    if (this._filters.triggers.length) msg.triggers = this._filters.triggers;

    try {
      const result = await this._hass.callWS(msg);
      this._recordings = result.recordings || [];
      this._pending = result.pending || [];
      if (this._recordings.length < DragontreeReolinkPlayback._PAGE_SIZE) this._hasMore = false;
      if (this._selectedIndex >= this._recordings.length) this._selectedIndex = -1;
    } catch (e) {
      console.error('[reolink] Failed to load recordings:', e);
      this._recordings = [];
      this._pending = [];
      this._hasMore = false;
    }
  }

  async _loadMoreRecordings() {
    if (this._loadingMore || !this._hasMore || !this._recordings.length) return;
    this._loadingMore = true;
    this._renderListFooter();

    const last = this._recordings[this._recordings.length - 1];
    const cursor = last.start_time || last.downloaded_at;
    if (!cursor) {
      this._hasMore = false;
      this._loadingMore = false;
      this._renderListFooter();
      return;
    }

    const msg = {
      type: 'dragontree_reolink/get_recordings',
      sort_desc: true,
      limit: DragontreeReolinkPlayback._PAGE_SIZE,
      before_dt: cursor,
    };
    if (this._filters.cameras.length) msg.cameras = this._filters.cameras;
    if (this._filters.triggers.length) msg.triggers = this._filters.triggers;

    try {
      const result = await this._hass.callWS(msg);
      const more = result.recordings || [];
      // pending is always current; update it on every page load
      this._pending = result.pending || this._pending;
      const startIndex = this._recordings.length;
      this._recordings = this._recordings.concat(more);
      if (more.length < DragontreeReolinkPlayback._PAGE_SIZE) this._hasMore = false;
      this._loadingMore = false;
      this._appendToList(more, startIndex);
    } catch (e) {
      console.error('[reolink] Failed to load more recordings:', e);
      this._hasMore = false;
      this._loadingMore = false;
      this._renderListFooter();
    }
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  _bindStaticEvents() {
    const sr = this.shadowRoot;

    sr.getElementById('filterToggle').addEventListener('click', () => {
      this._filtersOpen = !this._filtersOpen;
      sr.getElementById('filterToggle').classList.toggle('open', this._filtersOpen);
      sr.getElementById('filterBody').classList.toggle('open', this._filtersOpen);
      this._saveFilters();
    });

    sr.getElementById('filterIcon').addEventListener('click', (e) => {
      const active = this._filters.cameras.length > 0 || this._filters.triggers.length > 0 || this._filters.hidePending;
      if (active) {
        e.stopPropagation();
        this._clearFilters();
      }
    });

    sr.getElementById('filterBody').addEventListener('change', () => this._applyFilters());

    sr.getElementById('btnPrev').addEventListener('click', () => {
      const i = this._olderIndex();
      if (i !== -1) this._selectRecording(i);
    });

    sr.getElementById('btnPlayPause').addEventListener('click', () => {
      const video = this.shadowRoot.getElementById('videoArea')?.querySelector('video');
      if (!video) return;
      if (video.paused || video.ended) video.play();
      else video.pause();
    });

    sr.getElementById('btnNext').addEventListener('click', () => {
      const i = this._newerIndex();
      if (i !== -1) this._selectRecording(i);
    });

    // PlayerMixin shared button bindings (mute + fullscreen)
    this._bindPlayerButtons();
  }

  // ── Filter UI rendering ───────────────────────────────────────────────────

  _renderFilterInputs() {
    const sr = this.shadowRoot;
    if (!sr.getElementById('cameraChecks')) return; // not built yet

    // Camera checkboxes (hidden when there is only one camera)
    const cameraChecks = sr.getElementById('cameraChecks');
    cameraChecks.innerHTML = this._cameras.map(cam => `
      <label class="cb-item">
        <input type="checkbox" name="camera" value="${this._escHtml(cam)}"
               ${this._filters.cameras.includes(cam) ? 'checked' : ''}>
        ${this._escHtml(cam)}
      </label>
    `).join('');
    sr.getElementById('cameraGroup').style.display =
      this._cameras.length <= 1 ? 'none' : '';

    // Tag checkboxes
    const tagChecks = sr.getElementById('tagChecks');
    tagChecks.innerHTML = ['ANIMAL', 'VEHICLE', 'PERSON'].map(tag => `
      <label class="cb-item">
        <input type="checkbox" name="trigger" value="${tag}"
               ${this._filters.triggers.includes(tag) ? 'checked' : ''}>
        ${tag}
      </label>
    `).join('');

    // Option checkboxes
    const optionChecks = sr.getElementById('optionChecks');
    optionChecks.innerHTML = `
      <label class="cb-item">
        <input type="checkbox" name="option" value="hidePending"
               ${this._filters.hidePending ? 'checked' : ''}>
        Hide Pending
      </label>
    `;

    this._updateFilterIcon();
  }

  _applyFilters() {
    const sr = this.shadowRoot;

    this._filters = {
      cameras: Array.from(sr.querySelectorAll('input[name="camera"]:checked')).map(el => el.value),
      triggers: Array.from(sr.querySelectorAll('input[name="trigger"]:checked')).map(el => el.value),
      hidePending: !!sr.querySelector('input[name="option"][value="hidePending"]')?.checked,
    };

    this._saveFilters();
    this._updateFilterIcon();
    this._loadRecordings().then(() => this._renderList());
  }

  // ── Recording list rendering ──────────────────────────────────────────────

  _recItemHTML(rec, i) {
    const tags = parseTriggers(rec.triggers);
    const tagBadges = tags.map(t => `<span class="tag tag-${t}">${t}</span>`).join('');
    const selected = i === this._selectedIndex ? 'selected' : '';
    const tcid = rec.thumb_content_id ? this._escAttr(rec.thumb_content_id) : '';
    const thumbHtml = tcid
      ? `<img class="rec-thumb" data-cid="${tcid}" alt="">`
      : `<div class="rec-thumb-empty"></div>`;
    return `
      <div class="rec-item ${selected}" data-index="${i}">
        ${thumbHtml}
        <div class="rec-info">
          <div class="rec-camera">${this._escHtml(rec.camera)}</div>
          <div class="rec-time">${formatDate(rec.start_time)}${rec.duration_s ? ' &middot; ' + formatDuration(rec.duration_s) : ''}</div>
        </div>
        <div class="rec-right">
          <div class="rec-time-of-day">${formatTime(rec.start_time)}</div>
          <div class="rec-tags">${tagBadges}</div>
        </div>
      </div>
    `;
  }

  _pendingItemHTML(rec) {
    const tags = parseTriggers(rec.triggers);
    const tagBadges = tags.map(t => `<span class="tag tag-${t}">${t}</span>`).join('');
    const statusLabel = rec.status === 'downloading' ? 'DOWNLOADING' : rec.status === 'recording' ? 'RECORDING' : 'QUEUED';
    const statusBadge = `<span class="tag-${rec.status}">${statusLabel}</span>`;
    return `
      <div class="rec-item pending">
        <div class="rec-thumb-empty"></div>
        <div class="rec-info">
          <div class="rec-camera">${this._escHtml(rec.camera)}</div>
          <div class="rec-time">${formatDate(rec.start_time)}${rec.duration_s && rec.status !== 'recording' ? ' &middot; ' + formatDuration(rec.duration_s) : ''}</div>
        </div>
        <div class="rec-right">
          <div class="rec-time-of-day">${formatTime(rec.start_time)}</div>
          <div class="rec-tags">${statusBadge}${tagBadges}</div>
        </div>
      </div>
    `;
  }

  _renderList() {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    const visiblePending = this._filters.hidePending ? [] : this._pending;
    if (!this._recordings.length && !visiblePending.length) {
      listPanel.innerHTML = '<div class="list-msg">No recordings found</div>';
      this._updateNavButtons();
      return;
    }

    const pendingHtml = visiblePending.map(rec => this._pendingItemHTML(rec)).join('');
    listPanel.innerHTML = pendingHtml + this._recordings.map((rec, i) => this._recItemHTML(rec, i)).join('');

    listPanel.querySelectorAll('.rec-item').forEach(item => {
      item.addEventListener('click', () =>
        this._selectRecording(parseInt(item.dataset.index, 10))
      );
    });

    this._updateNavButtons();
    this._resolveThumbnails();
    this._renderListFooter();
  }

  _appendToList(items, startIndex) {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    // Remove footer before appending so new items land before it
    listPanel.querySelector('.list-footer')?.remove();

    const frag = document.createDocumentFragment();
    items.forEach((rec, offset) => {
      const i = startIndex + offset;
      const tmp = document.createElement('div');
      tmp.innerHTML = this._recItemHTML(rec, i);
      const item = tmp.firstElementChild;
      item.addEventListener('click', () => this._selectRecording(i));
      frag.appendChild(item);
    });
    listPanel.appendChild(frag);

    this._updateNavButtons();
    this._resolveThumbnails();
    this._renderListFooter();
  }

  _renderListFooter() {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    listPanel.querySelector('.list-footer')?.remove();

    if (!this._hasMore) return;

    const footer = document.createElement('div');
    footer.className = 'list-footer';
    footer.textContent = this._loadingMore ? 'Loading…' : '';
    listPanel.appendChild(footer);
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  async _selectRecording(index) {
    this._selectedIndex = index;
    const rec = this._recordings[index];
    if (!rec) return;

    this._renderList();

    // Scroll selected item into view
    const listPanel = this.shadowRoot.getElementById('listPanel');
    const selected = listPanel && listPanel.querySelector('.rec-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });

    // Resolve media URL via HA media_source WS command
    try {
      const resolved = await this._hass.callWS({
        type: 'media_source/resolve_media',
        media_content_id: rec.content_id,
      });
      this._playUrl(resolved.url);
    } catch (e) {
      console.error('[reolink] Failed to resolve media URL for', rec.content_id, e);
      const videoArea = this.shadowRoot.getElementById('videoArea');
      if (videoArea) videoArea.innerHTML = `<div class="no-selection">Could not load video</div>`;
    }
  }

  _applyMute() {
    const video = this.shadowRoot.getElementById('videoArea')?.querySelector('video');
    if (video) video.muted = this._muted;
  }

  _playUrl(url) {
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    videoArea.innerHTML = `<video autoplay playsinline src="${url}"></video>`;
    const video = videoArea.querySelector('video');
    video.muted = this._muted;

    // Clone seekBar to clear any listeners accumulated from previous recordings.
    const oldSeek = this.shadowRoot.getElementById('seekBar');
    const seekBar = oldSeek.cloneNode(true);
    oldSeek.replaceWith(seekBar);

    const timeDisplay = this.shadowRoot.getElementById('timeDisplay');
    const updateTime = () => {
      if (timeDisplay) timeDisplay.textContent = `${fmtVideoTime(video.currentTime)} / ${fmtVideoTime(video.duration)}`;
    };
    seekBar.value = 0;
    if (timeDisplay) timeDisplay.textContent = TIME_DISPLAY_EMPTY;
    video.addEventListener('loadedmetadata', () => { seekBar.max = video.duration; updateTime(); });
    video.addEventListener('timeupdate', () => {
      if (!seekBar._seeking) { seekBar.value = video.currentTime; updateTime(); }
    });
    seekBar.addEventListener('mousedown',  () => { seekBar._seeking = true; });
    seekBar.addEventListener('touchstart', () => { seekBar._seeking = true; }, { passive: true });
    seekBar.addEventListener('input',  () => { video.currentTime = seekBar.value; updateTime(); });
    seekBar.addEventListener('change', () => { video.currentTime = seekBar.value; seekBar._seeking = false; });

    video.addEventListener('play',  () => this._updatePlayPauseButton());
    video.addEventListener('pause', () => this._updatePlayPauseButton());
    video.addEventListener('ended', () => {
      const i = this._newerIndex();
      if (i !== -1) this._selectRecording(i);
      else this._updatePlayPauseButton();
    });
    this._updateMuteButton();
    this._updatePlayPauseButton();
  }

  _updatePlayPauseButton() {
    const btn = this.shadowRoot.getElementById('btnPlayPause');
    if (!btn) return;
    const video = this.shadowRoot.getElementById('videoArea')?.querySelector('video');
    btn.disabled = !video;
    const icon = (!video || video.paused || video.ended) ? 'mdi:play' : 'mdi:pause';
    btn.innerHTML = `<ha-icon icon="${icon}" style="--mdc-icon-size:18px"></ha-icon>`;
  }

  // ── Time-direction helpers ────────────────────────────────────────────────

  /** Index of the next-older recording, or -1 if none. List is always newest-first. */
  _olderIndex() {
    if (this._selectedIndex < 0) return -1;
    const i = this._selectedIndex + 1; // higher index = older
    return i < this._recordings.length ? i : -1;
  }

  /** Index of the next-newer recording, or -1 if none. List is always newest-first. */
  _newerIndex() {
    if (this._selectedIndex < 0) return -1;
    const i = this._selectedIndex - 1; // lower index = newer
    return i >= 0 ? i : -1;
  }

  _updateNavButtons() {
    const sr = this.shadowRoot;
    const prev = sr.getElementById('btnPrev');
    const next = sr.getElementById('btnNext');
    const fs = sr.getElementById('btnFullscreen');
    const seek = sr.getElementById('seekBar');
    const hasContent = this._selectedIndex >= 0;
    if (prev) prev.disabled = this._olderIndex() === -1;
    if (next) next.disabled = this._newerIndex() === -1;
    if (fs) fs.disabled = !hasContent;
    if (seek) seek.disabled = !hasContent;
    if (!hasContent) {
      this._updatePlayPauseButton();
      const td = sr.getElementById('timeDisplay');
      if (td) td.textContent = TIME_DISPLAY_EMPTY;
    }
  }

  // ── Thumbnail resolution ──────────────────────────────────────────────────

  _resolveThumbnails() {
    this.shadowRoot.querySelectorAll('.rec-thumb[data-cid]').forEach(img => {
      const contentId = img.dataset.cid;
      if (!contentId) return;

      if (this._thumbCache.has(contentId)) {
        img.src = this._thumbCache.get(contentId);
        return;
      }

      this._hass.callWS({
        type: 'media_source/resolve_media',
        media_content_id: contentId,
      }).then(resolved => {
        this._thumbCache.set(contentId, resolved.url);
        // img reference stays valid as long as this list render is live;
        // if it was replaced by a re-render the write is harmless.
        img.src = resolved.url;
      }).catch(() => { /* no thumbnail available */ });
    });
  }
}

// Mix in shared player methods
Object.assign(DragontreeReolinkPlayback.prototype, PlayerMixin);

customElements.define('dragontree-reolink-playback', DragontreeReolinkPlayback);

// ---------------------------------------------------------------------------
// dragontree-reolink-schedule
// ---------------------------------------------------------------------------

const SCHEDULE_STYLE = `
  :host { display: block; }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    min-height: 52px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .row:last-of-type { border-bottom: none; }
  .row-label { font-size: 1rem; color: var(--primary-text-color); }
  input[type="time"] {
    border: 1px solid var(--input-idle-line-color, var(--divider-color, #e0e0e0));
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 0.875rem;
    background: transparent;
    color: var(--primary-text-color);
  }
  .status-text {
    padding: 4px 16px 16px;
    font-size: 0.75rem;
    color: var(--secondary-text-color, #888);
    border-top: 1px solid var(--divider-color, #e0e0e0);
  }
`;

const SCHEDULE_TEMPLATE = `
  <style>${SCHEDULE_STYLE}</style>
  <ha-card header="Camera Schedule">
    <div class="row">
      <span class="row-label">Schedule Enabled</span>
      <ha-switch id="scheduleEnabled"></ha-switch>
    </div>
    <div class="row">
      <span class="row-label">Cameras on at</span>
      <input type="time" id="startTime" value="22:00">
    </div>
    <div class="row">
      <span class="row-label">Cameras off at</span>
      <input type="time" id="stopTime" value="06:00">
    </div>
    <div class="status-text" id="statusText"></div>
  </ha-card>
`;

class DragontreeReolinkScheduleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._initialized = false;
    this._saving = false;
  }

  setConfig(config) { this._config = config; }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
    }
  }

  _build() {
    this.shadowRoot.innerHTML = SCHEDULE_TEMPLATE;
    this._loadSchedule().then(() => this._bindEvents());
  }

  async _loadSchedule() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_schedule' });
      const sr = this.shadowRoot;
      // ha-switch uses a Lit property — must set via JS, not attribute
      const sw = sr.getElementById('scheduleEnabled');
      if (sw) sw.checked = !!result.enabled;
      sr.getElementById('startTime').value = result.start_time || '22:00';
      sr.getElementById('stopTime').value = result.stop_time || '06:00';
      this._updateStatus(result);
    } catch (e) {
      console.error('[reolink] Failed to load schedule:', e);
    }
  }

  _bindEvents() {
    const save = () => this._saveSchedule();
    this.shadowRoot.getElementById('scheduleEnabled').addEventListener('change', save);
    this.shadowRoot.getElementById('startTime').addEventListener('change', save);
    this.shadowRoot.getElementById('stopTime').addEventListener('change', save);
  }

  async _saveSchedule() {
    if (this._saving) return;
    this._saving = true;
    const sr = this.shadowRoot;
    const enabled = sr.getElementById('scheduleEnabled').checked;
    const startTime = sr.getElementById('startTime').value;
    const stopTime = sr.getElementById('stopTime').value;
    try {
      await this._hass.callWS({
        type: 'dragontree_reolink/set_schedule',
        enabled,
        start_time: startTime,
        stop_time: stopTime,
      });
      this._updateStatus({ enabled, start_time: startTime, stop_time: stopTime });
    } catch (e) {
      console.error('[reolink] Failed to save schedule:', e);
    } finally {
      this._saving = false;
    }
  }

  _updateStatus({ enabled, start_time, stop_time }) {
    const el = this.shadowRoot.getElementById('statusText');
    if (!el) return;
    if (!enabled) {
      el.textContent = 'Schedule disabled — cameras will not be automated.';
    } else {
      el.textContent = `Cameras will turn on at ${start_time} and off at ${stop_time}.`;
    }
  }
}

customElements.define('dragontree-reolink-schedule', DragontreeReolinkScheduleCard);

// ---------------------------------------------------------------------------
// dragontree-reolink-cameras
// ---------------------------------------------------------------------------

const CAMERAS_MGMT_STYLE = `
  :host { display: block; }
  .col-header {
    display: grid;
    grid-template-columns: 1fr auto auto 80px auto;
    gap: 8px;
    align-items: center;
    padding: 0 16px 8px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .col-label {
    font-size: 0.72em;
    font-weight: 600;
    color: var(--secondary-text-color, #666);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    text-align: center;
    white-space: nowrap;
  }
  .col-label:first-child { text-align: left; }
  .cam-row {
    display: grid;
    grid-template-columns: 1fr auto auto 80px auto;
    gap: 8px;
    align-items: center;
    padding: 0 16px;
    min-height: 52px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .cam-row:last-child { border-bottom: none; }
  .cam-name {
    font-size: 1rem;
    color: var(--primary-text-color);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cell-center {
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .sens-control {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  input[type="range"] {
    flex: 1;
    min-width: 0;
    accent-color: var(--primary-color, #03a9f4);
    cursor: pointer;
  }
  input[type="range"]:disabled { opacity: 0.4; cursor: default; }
  .sens-value {
    font-size: 0.82em;
    min-width: 18px;
    text-align: right;
    color: var(--primary-text-color);
  }
  .list-msg {
    padding: 16px;
    text-align: center;
    color: var(--secondary-text-color, #888);
    font-size: 0.875rem;
  }
  .cam-row.offline {
    opacity: 0.5;
  }
  .cam-row.offline .cam-name {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .offline-badge {
    display: inline-block;
    font-size: 0.65em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--error-color, #db4437);
    border: 1px solid var(--error-color, #db4437);
    border-radius: 3px;
    padding: 1px 4px;
    line-height: 1.4;
    flex-shrink: 0;
  }
`;

const CAMERAS_MGMT_TEMPLATE = `
  <style>${CAMERAS_MGMT_STYLE}</style>
  <ha-card header="Camera Management">
    <div class="col-header">
      <span class="col-label">Camera</span>
      <span class="col-label">Enabled</span>
      <span class="col-label">RFA</span>
      <span class="col-label">Sens</span>
      <span class="col-label">Sched</span>
    </div>
    <div id="cameraList"><div class="list-msg">Loading…</div></div>
  </ha-card>
`;

class DragontreeReolinkCamerasCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._initialized = false;
    this._cameras = [];
    this._suppressedUntil = {}; // entity_id → timestamp; skip _syncStates() while pending
  }

  /** After a service call, suppress sync for this entity to avoid flicker. */
  _suppressSync(entityId, ms = 3000) {
    this._suppressedUntil[entityId] = Date.now() + ms;
  }

  setConfig(config) { this._config = config; }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
    } else {
      // Sync toggle and slider states whenever HA pushes a state update
      this._syncStates();
    }
  }

  _build() {
    this.shadowRoot.innerHTML = CAMERAS_MGMT_TEMPLATE;
    this._loadCameras();
  }

  async _loadCameras() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_cameras_config' });
      this._cameras = result.cameras || [];
      this._renderCameras();
    } catch (e) {
      console.error('[reolink] Failed to load cameras config:', e);
      const list = this.shadowRoot.getElementById('cameraList');
      if (list) list.innerHTML = '<div class="list-msg">Failed to load cameras</div>';
    }
  }

  _renderCameras() {
    const list = this.shadowRoot.getElementById('cameraList');
    if (!list) return;

    if (!this._cameras.length) {
      list.innerHTML = '<div class="list-msg">No cameras found</div>';
      return;
    }

    // Build structural HTML — ha-switch checked/disabled must be set as JS properties after insertion
    list.innerHTML = this._cameras.map((cam) => {
      const sensVal = cam.sensitivity ?? '';
      const sensMin = cam.sensitivity_min ?? 0;
      const sensMax = cam.sensitivity_max ?? 100;
      const sensUnavail = !cam.sensitivity_entity_id || cam.online === false;
      const offline = cam.online === false;

      return `
        <div class="cam-row${offline ? ' offline' : ''}">
          <span class="cam-name">${this._escHtml(cam.name)}${offline ? '<span class="offline-badge">Offline</span>' : ''}</span>
          <div class="cell-center">
            <ha-switch class="pir-toggle"
              data-entity="${this._escAttr(cam.pir_entity_id || '')}"
              title="Enable / disable PIR detection"></ha-switch>
          </div>
          <div class="cell-center">
            <ha-switch class="rfa-toggle"
              data-entity="${this._escAttr(cam.rfa_entity_id || '')}"
              title="Reduce false alarms"></ha-switch>
          </div>
          <div class="sens-control">
            <input type="range" class="sensitivity-slider"
              data-entity="${this._escAttr(cam.sensitivity_entity_id || '')}"
              data-prev-value="${sensVal}"
              min="${sensMin}" max="${sensMax}" step="1"
              value="${sensVal || sensMin}"
              ${sensUnavail ? 'disabled' : ''}>
            <span class="sens-value">${sensVal !== '' ? Math.round(sensVal) : '—'}</span>
          </div>
          <div class="cell-center">
            <ha-switch class="schedule-toggle"
              data-camera="${this._escAttr(cam.name)}"
              title="Include in schedule"></ha-switch>
          </div>
        </div>
      `;
    }).join('');

    // Set checked/disabled properties on ha-switch elements (Lit props, not HTML attributes)
    this._cameras.forEach((cam, i) => {
      const row = list.querySelectorAll('.cam-row')[i];
      if (!row) return;

      const offline = cam.online === false;
      const pirState = this._hass.states[cam.pir_entity_id];
      const pirSw = row.querySelector('.pir-toggle');
      if (pirSw) { pirSw.checked = pirState ? pirState.state === 'on' : false; pirSw.disabled = !pirState || offline; }

      const rfaState = cam.rfa_entity_id ? this._hass.states[cam.rfa_entity_id] : null;
      const rfaSw = row.querySelector('.rfa-toggle');
      if (rfaSw) { rfaSw.checked = rfaState ? rfaState.state === 'on' : false; rfaSw.disabled = !rfaState || !cam.rfa_entity_id || offline; }

      const schedSw = row.querySelector('.schedule-toggle');
      if (schedSw) { schedSw.checked = !!cam.in_schedule; schedSw.disabled = offline || !cam.pir_entity_id; }
    });

    // PIR enable/disable
    list.querySelectorAll('.pir-toggle').forEach(sw => {
      sw.addEventListener('change', async () => {
        const entityId = sw.dataset.entity;
        const service = sw.checked ? 'turn_on' : 'turn_off';
        this._suppressSync(entityId);
        try {
          await this._hass.callService('switch', service, { entity_id: entityId });
        } catch (e) {
          console.error('[reolink] Failed to toggle PIR:', e);
          delete this._suppressedUntil[entityId];
          sw.checked = !sw.checked;
        }
      });
    });

    // Reduce false alarm toggle
    list.querySelectorAll('.rfa-toggle').forEach(sw => {
      sw.addEventListener('change', async () => {
        const entityId = sw.dataset.entity;
        if (!entityId) return;
        const service = sw.checked ? 'turn_on' : 'turn_off';
        this._suppressSync(entityId);
        try {
          await this._hass.callService('switch', service, { entity_id: entityId });
        } catch (e) {
          console.error('[reolink] Failed to toggle RFA:', e);
          delete this._suppressedUntil[entityId];
          sw.checked = !sw.checked;
        }
      });
    });

    // Sensitivity slider — live display update on drag, save on release
    list.querySelectorAll('.sensitivity-slider').forEach(slider => {
      const valEl = slider.parentElement.querySelector('.sens-value');
      slider.addEventListener('input', () => {
        if (valEl) valEl.textContent = slider.value;
      });
      slider.addEventListener('change', async () => {
        const entityId = slider.dataset.entity;
        if (!entityId) return;
        const newValue = parseFloat(slider.value);
        const prevValue = slider.dataset.prevValue;
        slider.dataset.prevValue = slider.value;
        this._suppressSync(entityId);
        try {
          await this._hass.callService('number', 'set_value', { entity_id: entityId, value: newValue });
        } catch (e) {
          console.error('[reolink] Failed to set sensitivity:', e);
          delete this._suppressedUntil[entityId];
          slider.value = prevValue;
          if (valEl) valEl.textContent = prevValue;
        }
      });
    });

    // Schedule inclusion
    list.querySelectorAll('.schedule-toggle').forEach(sw => {
      sw.addEventListener('change', async () => {
        try {
          await this._hass.callWS({
            type: 'dragontree_reolink/set_camera_in_schedule',
            camera: sw.dataset.camera,
            in_schedule: sw.checked,
          });
        } catch (e) {
          console.error('[reolink] Failed to update schedule inclusion:', e);
          sw.checked = !sw.checked;
        }
      });
    });
  }

  /** Keep toggle and slider states in sync when HA pushes entity state changes. */
  _syncStates() {
    const now = Date.now();
    const UNAVAIL = new Set(['unavailable', 'unknown']);

    this.shadowRoot.querySelectorAll('.pir-toggle').forEach(sw => {
      if ((this._suppressedUntil[sw.dataset.entity] || 0) > now) return;
      const state = this._hass.states[sw.dataset.entity];
      if (!state) return;
      const offline = UNAVAIL.has(state.state);
      // Update offline styling on the row
      const row = sw.closest('.cam-row');
      if (row) {
        row.classList.toggle('offline', offline);
        const badge = row.querySelector('.offline-badge');
        if (offline && !badge) {
          const nameEl = row.querySelector('.cam-name');
          if (nameEl) nameEl.insertAdjacentHTML('beforeend', '<span class="offline-badge">Offline</span>');
        } else if (!offline && badge) {
          badge.remove();
        }
      }
      sw.checked = state.state === 'on';
      sw.disabled = offline;
    });
    this.shadowRoot.querySelectorAll('.rfa-toggle').forEach(sw => {
      if (!sw.dataset.entity) return;
      if ((this._suppressedUntil[sw.dataset.entity] || 0) > now) return;
      const state = this._hass.states[sw.dataset.entity];
      if (!state) return;
      const offline = UNAVAIL.has(state.state);
      sw.checked = state.state === 'on';
      sw.disabled = offline;
    });
    this.shadowRoot.querySelectorAll('.sensitivity-slider').forEach(slider => {
      if (!slider.dataset.entity) return;
      if ((this._suppressedUntil[slider.dataset.entity] || 0) > now) return;
      const state = this._hass.states[slider.dataset.entity];
      if (!state) return;
      if (UNAVAIL.has(state.state)) { slider.disabled = true; return; }
      const parsed = parseFloat(state.state);
      if (isNaN(parsed)) return;
      slider.value = parsed;
      slider.disabled = false;
      slider.dataset.prevValue = parsed;
      const valEl = slider.parentElement.querySelector('.sens-value');
      if (valEl) valEl.textContent = Math.round(parsed);
    });
  }

  _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

customElements.define('dragontree-reolink-cameras', DragontreeReolinkCamerasCard);

// ---------------------------------------------------------------------------
// dragontree-reolink-timers
// ---------------------------------------------------------------------------

const TIMERS_STYLE = `
  :host { display: block; }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    min-height: 52px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .row:last-of-type { border-bottom: none; }
  .row-label { font-size: 1rem; color: var(--primary-text-color); }
  .input-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  input[type="text"] {
    border: 1px solid var(--input-idle-line-color, var(--divider-color, #e0e0e0));
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 0.875rem;
    background: transparent;
    color: var(--primary-text-color);
    width: 72px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  input.error { border-color: var(--error-color, #db4437); }
  .field-error {
    font-size: 0.7rem;
    color: var(--error-color, #db4437);
    min-height: 1em;
  }
  .status-text {
    padding: 4px 16px 16px;
    font-size: 0.75rem;
    color: var(--secondary-text-color, #888);
    border-top: 1px solid var(--divider-color, #e0e0e0);
  }
`;

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
    <div class="status-text" id="statusText">Range: 0:15 – 10:00</div>
  </ha-card>
`;

class DragontreeReolinkTimersCard extends HTMLElement {
  static _MIN_SECS = 15;
  static _MAX_SECS = 600;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._initialized = false;
    this._saving = false;
  }

  setConfig(config) { this._config = config; }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
    }
  }

  _build() {
    this.shadowRoot.innerHTML = TIMERS_TEMPLATE;
    this._loadConfig().then(() => this._bindEvents());
  }

  async _loadConfig() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_timer_config' });
      this.shadowRoot.getElementById('liveTimeout').value =
        this._secsToMmss(result.live_timeout_secs);
      this.shadowRoot.getElementById('recTimeout').value =
        this._secsToMmss(result.record_timeout_secs);
    } catch (e) {
      console.error('[reolink] Failed to load timer config:', e);
    }
  }

  _bindEvents() {
    const sr = this.shadowRoot;
    const onLiveChange = () => this._onFieldChange('liveTimeout', 'liveErr');
    const onRecChange  = () => this._onFieldChange('recTimeout', 'recErr');

    sr.getElementById('liveTimeout').addEventListener('change', onLiveChange);
    sr.getElementById('liveTimeout').addEventListener('blur', onLiveChange);
    sr.getElementById('recTimeout').addEventListener('change', onRecChange);
    sr.getElementById('recTimeout').addEventListener('blur', onRecChange);
  }

  _onFieldChange(inputId, errId) {
    const sr = this.shadowRoot;
    const input = sr.getElementById(inputId);
    const errEl = sr.getElementById(errId);
    const secs = this._mmssToSecs(input.value);

    if (secs === null) {
      input.classList.add('error');
      errEl.textContent = 'Use M:SS format';
      return;
    }
    if (secs < DragontreeReolinkTimersCard._MIN_SECS ||
        secs > DragontreeReolinkTimersCard._MAX_SECS) {
      input.classList.add('error');
      errEl.textContent = '0:15 – 10:00';
      return;
    }

    input.classList.remove('error');
    errEl.textContent = '';
    input.value = this._secsToMmss(secs); // normalize display
    this._save();
  }

  async _save() {
    if (this._saving) return;
    const sr = this.shadowRoot;

    const liveSecs = this._mmssToSecs(sr.getElementById('liveTimeout').value);
    const recSecs  = this._mmssToSecs(sr.getElementById('recTimeout').value);
    if (liveSecs === null || recSecs === null) return;
    if (liveSecs < DragontreeReolinkTimersCard._MIN_SECS ||
        liveSecs > DragontreeReolinkTimersCard._MAX_SECS ||
        recSecs < DragontreeReolinkTimersCard._MIN_SECS ||
        recSecs > DragontreeReolinkTimersCard._MAX_SECS) return;

    this._saving = true;
    try {
      await this._hass.callWS({
        type: 'dragontree_reolink/set_timer_config',
        live_timeout_secs: liveSecs,
        record_timeout_secs: recSecs,
      });
      const statusEl = sr.getElementById('statusText');
      if (statusEl) {
        statusEl.textContent = 'Saved.';
        setTimeout(() => { statusEl.textContent = 'Range: 0:15 – 10:00'; }, 2000);
      }
    } catch (e) {
      console.error('[reolink] Failed to save timer config:', e);
    } finally {
      this._saving = false;
    }
  }

  _secsToMmss(secs) {
    const s = Math.max(0, Math.round(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  _mmssToSecs(str) {
    const m = String(str).trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
}

customElements.define('dragontree-reolink-timers', DragontreeReolinkTimersCard);

// ---------------------------------------------------------------------------
// dragontree-reolink-live
// ---------------------------------------------------------------------------

const LIVE_STYLE = PLAYER_STYLE + `
  /* ── Camera list ── */
  .cam-item {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    cursor: pointer;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    gap: 10px;
    transition: background 0.1s;
  }
  .cam-item:last-child { border-bottom: none; }
  .cam-item:hover { background: var(--secondary-background-color, #f5f5f5); }
  .cam-item.selected { background: var(--primary-color-light, #e3f2fd); }
  .cam-item.offline { opacity: 0.5; }
  .cam-info { flex: 1; min-width: 0; }
  .cam-name {
    font-size: 0.92em;
    font-weight: 500;
    color: var(--primary-text-color, #212121);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cam-badges { display: flex; gap: 4px; margin-top: 3px; }
  .badge-offline {
    font-size: 0.65em;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--error-color, #db4437);
    border: 1px solid var(--error-color, #db4437);
    border-radius: 3px;
    padding: 1px 4px;
    text-transform: uppercase;
  }
  .badge-rec-list {
    font-size: 0.65em;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: #fce4ec;
    color: #b71c1c;
    text-transform: uppercase;
  }
  .badge-manrec-list {
    font-size: 0.65em;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: #c62828;
    color: #fff;
    text-transform: uppercase;
  }
  .cam-icon {
    --mdc-icon-size: 20px;
    color: var(--secondary-text-color, #888);
    flex-shrink: 0;
  }
  .cam-icon.live { color: var(--primary-color, #03a9f4); }

  /* Live-specific button states */
  .ctrl-btn.live {
    background: var(--primary-color, #03a9f4);
    border-color: var(--primary-color, #03a9f4);
  }
  .ctrl-btn.recording-active {
    background: #c62828;
    border-color: #c62828;
  }

  /* Timer display — overrides base .timer colours with live-specific names */
  .timer-display {
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,0.45);
    min-width: 36px;
    white-space: nowrap;
  }
  .timer-display.active { color: #fff; }
  .timer-display.urgent { color: #ef5350; }
  .timer-display.recording { color: #ef9a9a; }
`;

const LIVE_TEMPLATE = `
  <style>${LIVE_STYLE}</style>
  <div class="container">

    <div class="player-panel" id="playerPanel">
      <div class="video-area" id="videoArea">
        <div class="no-selection">Select a camera to view</div>
      </div>
      <div class="controls-bar" id="controlsBar">
        <div class="controls-row">
          <button class="ctrl-btn" id="btnPlayPause" disabled>
            <ha-icon icon="mdi:play" style="--mdc-icon-size:16px"></ha-icon>
            Start
          </button>
          <span class="timer-display" id="timerLive">--:--</span>
          <button class="ctrl-btn" id="btnRecord" disabled>
            <ha-icon icon="mdi:record" style="--mdc-icon-size:16px"></ha-icon>
            Record
          </button>
          <span class="timer-display" id="timerRec">--:--</span>
          <div class="ctrl-spacer"></div>
          <button class="ctrl-btn icon-only" id="btnMute" disabled>
            <ha-icon icon="mdi:volume-high" style="--mdc-icon-size:18px"></ha-icon>
          </button>
          <button class="ctrl-btn icon-only" id="btnFullscreen" disabled>
            <ha-icon icon="mdi:fullscreen" style="--mdc-icon-size:18px"></ha-icon>
          </button>
        </div>
      </div>
    </div>

    <div class="right-panel">
      <div class="list-panel" id="listPanel">
        <div class="list-msg">Loading…</div>
      </div>
    </div>

  </div>
`;

class DragontreeReolinkLiveCard extends HTMLElement {
  static _DEFAULT_LIVE_TIMEOUT = 120; // seconds

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._config = {};
    this._initialized = false;

    this._cameras = [];
    this._selectedCamera = null;
    this._isLive = false;

    this._liveTimeoutSecs = DragontreeReolinkLiveCard._DEFAULT_LIVE_TIMEOUT;
    this._liveSecondsLeft = 0;
    this._liveTimerInterval = null;

    // Recording display — driven by server-side timer events
    this._recStartedAt = null;         // Date from server when recording started
    this._recServerTimeoutSecs = 0;    // timeout_secs from server
    this._recDisplayInterval = null;   // local setInterval for display ticking only
    this._unsubRecordTimerEvent = null;
    this._recStateOptimistic = null;   // null = use entity state, true/false = optimistic

    // PlayerMixin state
    this._initPlayer();
  }

  setConfig(config) {
    this._config = config || {};
    if (config && config.live_timeout_seconds) {
      this._liveTimeoutSecs = parseInt(config.live_timeout_seconds, 10) ||
        DragontreeReolinkLiveCard._DEFAULT_LIVE_TIMEOUT;
    }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
      return;
    }
    // Keep the camera stream's hass reference current (needed for auth token refresh)
    const streamEl = this.shadowRoot.getElementById('videoArea')
      ?.querySelector('ha-camera-stream');
    if (streamEl) streamEl.hass = hass;

    this._syncRecordingState(prev);
    this._updateCameraListBadges();
  }

  disconnectedCallback() {
    this._stopLive();
    this._stopRecordDisplay();
    if (this._unsubRecordTimerEvent) {
      this._unsubRecordTimerEvent();
      this._unsubRecordTimerEvent = null;
    }
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  _build() {
    this.shadowRoot.innerHTML = LIVE_TEMPLATE;
    this._bindStaticEvents();
    Promise.all([this._loadCameras(), this._loadTimerConfig()]).then(() => {
      this._renderCameraList();
      this._subscribeRecordTimerEvent();
    });
  }

  async _loadTimerConfig() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_timer_config' });
      if (result.live_timeout_secs) this._liveTimeoutSecs = result.live_timeout_secs;
    } catch (e) {
      // falls back to card config value / default
    }
  }

  async _loadCameras() {
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_cameras_config' });
      this._cameras = result.cameras || [];
    } catch (e) {
      console.error('[reolink-live] Failed to load cameras:', e);
      const list = this.shadowRoot.getElementById('listPanel');
      if (list) list.innerHTML = '<div class="list-msg">Failed to load cameras</div>';
    }
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  _bindStaticEvents() {
    const sr = this.shadowRoot;

    sr.getElementById('btnPlayPause').addEventListener('click', () => {
      if (this._isLive) {
        this._stopLive();
      } else if (this._selectedCamera) {
        this._startLive();
      }
    });

    // PlayerMixin shared button bindings (mute + fullscreen)
    this._bindPlayerButtons();

    sr.getElementById('btnRecord').addEventListener('click', async () => {
      if (!this._selectedCamera?.record_entity_id) return;
      const entityId = this._selectedCamera.record_entity_id;
      const isOn = this._hass.states[entityId]?.state === 'on';
      // Optimistic UI update — button responds immediately
      this._recStateOptimistic = !isOn;
      if (isOn) this._stopRecordDisplay(); // optimistically hide timer on stop
      this._updateRecordButton();
      this._updateTimerDisplay();

      try {
        await this._hass.callService('switch', isOn ? 'turn_off' : 'turn_on',
          { entity_id: entityId });
      } catch (e) {
        console.error('[reolink-live] Failed to toggle recording:', e);
        this._recStateOptimistic = null;
        if (!isOn) this._stopRecordDisplay();
        this._updateRecordButton();
        this._updateTimerDisplay();
      }
    });
  }

  // ── Camera selection ──────────────────────────────────────────────────────

  _selectCamera(cam) {
    if (this._selectedCamera?.name === cam.name) return;
    this._stopLive();
    this._stopRecordDisplay();
    this._selectedCamera = cam;
    this._fetchRecordTimers(); // pick up any active timer for this camera
    this._renderCameraList();
    this._updateRecordButton();

    this._startLive();
  }

  // ── Live view ─────────────────────────────────────────────────────────────

  _applyMute() {
    const streamEl = this.shadowRoot.getElementById('videoArea')
      ?.querySelector('ha-camera-stream');
    if (streamEl) streamEl.muted = this._muted;
  }

  _startLive() {
    if (!this._selectedCamera) return;
    const cameraEntityId = this._selectedCamera.camera_entity_id;
    if (!cameraEntityId || !this._hass.states[cameraEntityId]) {
      console.warn('[reolink-live] No camera entity for', this._selectedCamera.name,
        '— entity_id:', cameraEntityId);
      const videoArea = this.shadowRoot.getElementById('videoArea');
      if (videoArea) {
        videoArea.innerHTML = `<div class="no-selection">Live view unavailable for this camera</div>`;
      }
      return;
    }

    this._isLive = true;
    this._liveSecondsLeft = this._liveTimeoutSecs;

    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (videoArea) {
      videoArea.innerHTML = '';
      const streamEl = document.createElement('ha-camera-stream');
      streamEl.hass = this._hass;
      streamEl.stateObj = this._hass.states[cameraEntityId];
      streamEl.controls = false;
      streamEl.muted = this._muted;
      videoArea.appendChild(streamEl);
    }

    clearInterval(this._liveTimerInterval);
    this._liveTimerInterval = setInterval(() => {
      this._liveSecondsLeft--;
      this._updateTimerDisplay();
      if (this._liveSecondsLeft <= 0) {
        this._stopLive();
      }
    }, 1000);

    this._updatePlayPauseButton();
    this._updateTimerDisplay();
    this._updateCameraListBadges();
  }

  _stopLive() {
    this._isLive = false;
    clearInterval(this._liveTimerInterval);
    this._liveTimerInterval = null;

    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (videoArea) {
      if (this._selectedCamera) {
        videoArea.innerHTML = `
          <div class="paused-overlay">
            <ha-icon icon="mdi:pause-circle-outline"></ha-icon>
            <div>Live view paused — press Start to resume</div>
          </div>`;
      } else {
        videoArea.innerHTML = `<div class="no-selection">Select a camera to view</div>`;
      }
    }

    this._updatePlayPauseButton();
    this._updateTimerDisplay();
    this._updateCameraListBadges();
  }

  // ── Record timer event subscription & display ────────────────────────────

  _subscribeRecordTimerEvent() {
    if (this._unsubRecordTimerEvent) return;
    this._hass.connection.subscribeEvents(
      (event) => this._onRecordTimerEvent(event.data),
      'dragontree_reolink_record_timer_changed'
    ).then(unsub => {
      this._unsubRecordTimerEvent = unsub;
    }).catch(err => console.warn('[reolink-live] Record timer subscription failed:', err));
  }

  _onRecordTimerEvent(data) {
    if (data.camera !== this._selectedCamera?.name) return;
    if (data.action === 'started') {
      this._startRecordDisplay(new Date(data.started_at), data.timeout_secs);
    } else {
      this._stopRecordDisplay();
    }
    this._updateTimerDisplay();
  }

  async _fetchRecordTimers() {
    if (!this._selectedCamera) return;
    try {
      const result = await this._hass.callWS({ type: 'dragontree_reolink/get_record_timers' });
      const timer = result.timers?.[this._selectedCamera.name];
      if (timer) {
        this._startRecordDisplay(new Date(timer.started_at), timer.timeout_secs);
      } else {
        this._stopRecordDisplay();
      }
      this._updateTimerDisplay();
    } catch (e) {
      console.error('[reolink-live] Failed to fetch record timers:', e);
    }
  }

  _startRecordDisplay(startedAt, timeoutSecs) {
    this._stopRecordDisplay();
    this._recStartedAt = startedAt;
    this._recServerTimeoutSecs = timeoutSecs;
    this._recDisplayInterval = setInterval(() => this._updateTimerDisplay(), 1000);
    this._updateTimerDisplay();
  }

  _stopRecordDisplay() {
    clearInterval(this._recDisplayInterval);
    this._recDisplayInterval = null;
    this._recStartedAt = null;
    this._recServerTimeoutSecs = 0;
  }

  // ── State sync (called on every hass update) ──────────────────────────────

  _syncRecordingState(prev) {
    if (!this._selectedCamera?.record_entity_id) return;
    const entityId = this._selectedCamera.record_entity_id;
    const prevState = prev?.states[entityId];
    const currState = this._hass.states[entityId];
    if (!currState) return;

    const isOn = currState.state === 'on';
    const wasOn = prevState?.state === 'on';

    // Real state has arrived — clear optimistic override
    this._recStateOptimistic = null;

    // When recording stops, clear the display (server fires event too, belt-and-suspenders)
    if (!isOn && wasOn) {
      this._stopRecordDisplay();
    }

    this._updateRecordButton();
    this._updateTimerDisplay();
  }

  // ── UI rendering ──────────────────────────────────────────────────────────

  _renderCameraList() {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    if (!this._cameras.length) {
      listPanel.innerHTML = '<div class="list-msg">No cameras found</div>';
      return;
    }

    listPanel.innerHTML = this._cameras.map((cam, i) => {
      const isSelected = this._selectedCamera?.name === cam.name;
      const isLiveThis = isSelected && this._isLive;
      const badges = this._camBadgesHtml(cam);

      return `
        <div class="cam-item${isSelected ? ' selected' : ''}${!cam.online ? ' offline' : ''}"
             data-index="${i}">
          <ha-icon class="cam-icon${isLiveThis ? ' live' : ''}"
                   icon="${isLiveThis ? 'mdi:video' : 'mdi:camera'}"></ha-icon>
          <div class="cam-info">
            <div class="cam-name">${this._escHtml(cam.name)}</div>
            ${badges ? `<div class="cam-badges">${badges}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    listPanel.querySelectorAll('.cam-item').forEach(item => {
      item.addEventListener('click', () => {
        const cam = this._cameras[parseInt(item.dataset.index, 10)];
        if (cam) this._selectCamera(cam);
      });
    });
  }

  /** Lightweight badge/icon refresh without full list re-render. */
  _updateCameraListBadges() {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    listPanel.querySelectorAll('.cam-item[data-index]').forEach(item => {
      const cam = this._cameras[parseInt(item.dataset.index, 10)];
      if (!cam) return;

      const isSelected = this._selectedCamera?.name === cam.name;
      const isLiveThis = isSelected && this._isLive;

      item.classList.toggle('selected', isSelected);
      item.classList.toggle('offline', !cam.online);

      const icon = item.querySelector('.cam-icon');
      if (icon) {
        icon.setAttribute('icon', isLiveThis ? 'mdi:video' : 'mdi:camera');
        icon.classList.toggle('live', isLiveThis);
      }

      const badgesHtml = this._camBadgesHtml(cam);
      const badgesEl = item.querySelector('.cam-badges');
      if (badgesHtml) {
        if (badgesEl) {
          badgesEl.innerHTML = badgesHtml;
        } else {
          item.querySelector('.cam-info')
            ?.insertAdjacentHTML('beforeend', `<div class="cam-badges">${badgesHtml}</div>`);
        }
      } else if (badgesEl) {
        badgesEl.remove();
      }
    });
  }

  _camBadgesHtml(cam) {
    const parts = [];
    if (!cam.online) parts.push('<span class="badge-offline">Offline</span>');
    if (this._isManualRecording(cam)) {
      parts.push('<span class="badge-manrec-list">Manual Rec</span>');
    }
    return parts.join('');
  }

  _updatePlayPauseButton() {
    const btn = this.shadowRoot.getElementById('btnPlayPause');
    if (!btn) return;
    btn.disabled = !this._selectedCamera;
    if (this._isLive) {
      btn.innerHTML = '<ha-icon icon="mdi:pause" style="--mdc-icon-size:16px"></ha-icon> Pause';
      btn.classList.add('live');
    } else {
      btn.innerHTML = '<ha-icon icon="mdi:play" style="--mdc-icon-size:16px"></ha-icon> Start';
      btn.classList.remove('live');
    }
    this._updateFullscreenButton();
    this._updateMuteButton();
  }

  // Override PlayerMixin _updateMuteButton to handle disabled state
  _updateMuteButton() {
    const btn = this.shadowRoot.getElementById('btnMute');
    if (!btn) return;
    btn.disabled = !this._isLive;
    btn.innerHTML = `<ha-icon icon="${this._muted ? 'mdi:volume-off' : 'mdi:volume-high'}" style="--mdc-icon-size:18px"></ha-icon>`;
  }

  // Override PlayerMixin _updateFullscreenButton to handle disabled state
  _updateFullscreenButton() {
    const btn = this.shadowRoot.getElementById('btnFullscreen');
    if (!btn) return;
    btn.disabled = !this._isLive;
    const isFs = !!document.fullscreenElement || this._fakeFullscreen;
    btn.innerHTML = `<ha-icon icon="${isFs ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'}" style="--mdc-icon-size:18px"></ha-icon>`;
  }

  _updateRecordButton() {
    const btn = this.shadowRoot.getElementById('btnRecord');
    if (!btn) return;

    if (!this._selectedCamera) {
      btn.disabled = true;
      btn.classList.remove('recording-active');
      btn.innerHTML = '<ha-icon icon="mdi:record" style="--mdc-icon-size:16px"></ha-icon> Record';
      return;
    }

    const isManualRec = this._isManualRecording(this._selectedCamera);

    if (isManualRec) {
      btn.disabled = false;
      btn.classList.add('recording-active');
      btn.innerHTML = '<ha-icon icon="mdi:stop" style="--mdc-icon-size:16px"></ha-icon> Stop Rec';
    } else {
      btn.disabled = !this._selectedCamera.record_entity_id;
      btn.classList.remove('recording-active');
      btn.innerHTML = '<ha-icon icon="mdi:record" style="--mdc-icon-size:16px"></ha-icon> Record';
    }
  }

  _updateTimerDisplay() {
    const liveEl = this.shadowRoot.getElementById('timerLive');
    const recEl  = this.shadowRoot.getElementById('timerRec');

    if (liveEl) {
      if (this._isLive) {
        liveEl.textContent = this._formatSecs(this._liveSecondsLeft);
        liveEl.className = 'timer-display active' +
          (this._liveSecondsLeft <= 30 ? ' urgent' : '');
      } else {
        liveEl.textContent = '--:--';
        liveEl.className = 'timer-display';
      }
    }

    if (recEl) {
      if (this._recStartedAt) {
        const elapsed = (Date.now() - this._recStartedAt.getTime()) / 1000;
        const remaining = Math.max(0, this._recServerTimeoutSecs - elapsed);
        recEl.textContent = this._formatSecs(remaining);
        recEl.className = 'timer-display recording' + (remaining <= 30 ? ' urgent' : '');
      } else {
        recEl.textContent = '--:--';
        recEl.className = 'timer-display';
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _isManualRecording(cam) {
    if (!cam?.record_entity_id) return false;
    if (cam.name === this._selectedCamera?.name && this._recStateOptimistic !== null) {
      return this._recStateOptimistic;
    }
    return this._hass?.states[cam.record_entity_id]?.state === 'on';
  }

  _formatSecs(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// Mix in shared player methods (own methods defined above override the mixin)
Object.assign(DragontreeReolinkLiveCard.prototype, PlayerMixin);

customElements.define('dragontree-reolink-live', DragontreeReolinkLiveCard);
