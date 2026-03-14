/**
 * Dragontree Reolink — custom Lovelace cards
 *
 * Elements defined here:
 *   dragontree-reolink-playback  — 3-panel recording playback UI
 *   dragontree-reolink-schedule  — camera schedule on/off times
 *   dragontree-reolink-cameras   — per-camera enable + schedule toggles
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

/** Parse the triggers JSON stored in the DB into an array of strings. */
function parseTriggers(triggersJson) {
  if (!triggersJson) return [];
  try { return JSON.parse(triggersJson); } catch { return []; }
}

// ---------------------------------------------------------------------------
// dragontree-reolink-playback
// ---------------------------------------------------------------------------

const STYLE = `
  :host { display: block; }

  .container {
    display: grid;
    grid-template-columns: 1fr 380px;
    gap: 12px;
    height: 70vh;
    min-height: 420px;
  }
  @media (max-width: 800px) {
    .container {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
      height: calc(100dvh - 56px); /* 56px = HA header height */
      min-height: 400px;
    }
    .video-wrapper {
      aspect-ratio: 16 / 9;
      flex: none; /* size from aspect-ratio, not flex */
    }
  }

  /* ── Player ── */
  .player-panel {
    display: flex;
    flex-direction: column;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
    min-height: 0;
  }
  .video-wrapper {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .no-selection {
    color: #888;
    font-size: 0.9em;
    text-align: center;
    padding: 24px;
  }
  .player-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #1a1a1a;
    flex-shrink: 0;
  }
  .player-controls button {
    background: transparent;
    border: 1px solid #555;
    color: #ccc;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82em;
    transition: background 0.15s;
  }
  .player-controls button:hover { background: #333; color: #fff; }
  .player-controls button:disabled { opacity: 0.3; cursor: default; }

  /* ── Right panel ── */
  .right-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }

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

    <div class="player-panel">
      <div class="video-wrapper" id="videoWrapper">
        <div class="no-selection">Select a recording to play</div>
      </div>
      <div class="player-controls">
        <button id="btnPrev" disabled>&#9664; Prev</button>
        <button id="btnNext" disabled>Next &#9654;</button>
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
    this._hasMore = true;
    this._loadingMore = false;
    this._totalRecEntityId = null;  // sensor.dragontree_reolink_total_recordings
    this._lastTotalRec = null;      // last seen value of the sensor
    this._refreshTimer = null;      // debounce handle
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
    const active = this._filters.cameras.length > 0 || this._filters.triggers.length > 0;
    icon.setAttribute('icon', active ? 'mdi:filter' : 'mdi:filter-off');
    icon.classList.toggle('filters-active', active);
  }

  _clearFilters() {
    this._filters = this._defaultFilters();
    this._saveFilters();
    this._renderFilterInputs();
    this._loadRecordings().then(() => this._renderList());
  }

  disconnectedCallback() {
    if (this._unsubRecordingEvents) {
      this._unsubRecordingEvents();
      this._unsubRecordingEvents = null;
    }
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
      const active = this._filters.cameras.length > 0 || this._filters.triggers.length > 0;
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

    sr.getElementById('btnNext').addEventListener('click', () => {
      const i = this._newerIndex();
      if (i !== -1) this._selectRecording(i);
    });
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

    this._updateFilterIcon();
  }

  _applyFilters() {
    const sr = this.shadowRoot;

    this._filters = {
      cameras: Array.from(sr.querySelectorAll('input[name="camera"]:checked')).map(el => el.value),
      triggers: Array.from(sr.querySelectorAll('input[name="trigger"]:checked')).map(el => el.value),
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

    if (!this._recordings.length && !this._pending.length) {
      listPanel.innerHTML = '<div class="list-msg">No recordings found</div>';
      this._updateNavButtons();
      return;
    }

    const pendingHtml = this._pending.map(rec => this._pendingItemHTML(rec)).join('');
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
      const wrapper = this.shadowRoot.getElementById('videoWrapper');
      if (wrapper) wrapper.innerHTML = `<div class="no-selection">Could not load video</div>`;
    }
  }

  _playUrl(url) {
    const wrapper = this.shadowRoot.getElementById('videoWrapper');
    if (!wrapper) return;
    wrapper.innerHTML = `<video controls autoplay playsinline src="${url}"></video>`;
    wrapper.querySelector('video').addEventListener('ended', () => {
      // Auto-advance forward in time when playback ends
      const i = this._newerIndex();
      if (i !== -1) this._selectRecording(i);
    });
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
    if (!prev || !next) return;
    prev.disabled = this._olderIndex() === -1;
    next.disabled = this._newerIndex() === -1;
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

  // ── Utility ───────────────────────────────────────────────────────────────

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
      const sensUnavail = !cam.sensitivity_entity_id;

      return `
        <div class="cam-row">
          <span class="cam-name">${this._escHtml(cam.name)}</span>
          <div class="cell-center">
            <ha-switch class="pir-toggle"
              data-entity="${this._escAttr(cam.pir_entity_id)}"
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

      const pirState = this._hass.states[cam.pir_entity_id];
      const pirSw = row.querySelector('.pir-toggle');
      if (pirSw) { pirSw.checked = pirState ? pirState.state === 'on' : false; pirSw.disabled = !pirState; }

      const rfaState = cam.rfa_entity_id ? this._hass.states[cam.rfa_entity_id] : null;
      const rfaSw = row.querySelector('.rfa-toggle');
      if (rfaSw) { rfaSw.checked = rfaState ? rfaState.state === 'on' : false; rfaSw.disabled = !rfaState || !cam.rfa_entity_id; }

      const schedSw = row.querySelector('.schedule-toggle');
      if (schedSw) { schedSw.checked = !!cam.in_schedule; }
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
    this.shadowRoot.querySelectorAll('.pir-toggle').forEach(sw => {
      if ((this._suppressedUntil[sw.dataset.entity] || 0) > now) return;
      const state = this._hass.states[sw.dataset.entity];
      if (state) { sw.checked = state.state === 'on'; sw.disabled = false; }
    });
    this.shadowRoot.querySelectorAll('.rfa-toggle').forEach(sw => {
      if (!sw.dataset.entity) return;
      if ((this._suppressedUntil[sw.dataset.entity] || 0) > now) return;
      const state = this._hass.states[sw.dataset.entity];
      if (state) { sw.checked = state.state === 'on'; sw.disabled = false; }
    });
    this.shadowRoot.querySelectorAll('.sensitivity-slider').forEach(slider => {
      if (!slider.dataset.entity) return;
      if ((this._suppressedUntil[slider.dataset.entity] || 0) > now) return;
      const state = this._hass.states[slider.dataset.entity];
      if (state) {
        slider.value = state.state;
        slider.disabled = false;
        slider.dataset.prevValue = state.state;
        const valEl = slider.parentElement.querySelector('.sens-value');
        if (valEl) valEl.textContent = Math.round(parseFloat(state.state));
      }
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
