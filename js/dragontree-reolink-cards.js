/**
 * Dragontree Reolink — custom Lovelace cards
 *
 * Elements defined here:
 *   dragontree-reolink-playback  — 3-panel recording playback UI
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
    .container { grid-template-columns: 1fr; height: auto; }
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
          <span>Filters</span>
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
    this._cameras = [];
    this._selectedIndex = -1;
    this._filtersOpen = false;
    this._initialized = false;
    this._filters = this._defaultFilters();
    this._thumbCache = new Map(); // content_id → resolved URL
    this._unsubRecordingEvents = null;
    this._hasMore = true;
    this._loadingMore = false;
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
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._build();
    }
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
    this._hass.connection.subscribeEvents(
      () => this._refreshRecordings(),
      'dragontree_reolink_recording_added'
    ).then(unsub => { this._unsubRecordingEvents = unsub; });
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
      if (this._recordings.length < DragontreeReolinkPlayback._PAGE_SIZE) this._hasMore = false;
      if (this._selectedIndex >= this._recordings.length) this._selectedIndex = -1;
    } catch (e) {
      console.error('[reolink] Failed to load recordings:', e);
      this._recordings = [];
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

  }

  _applyFilters() {
    const sr = this.shadowRoot;

    this._filters = {
      cameras: Array.from(sr.querySelectorAll('input[name="camera"]:checked')).map(el => el.value),
      triggers: Array.from(sr.querySelectorAll('input[name="trigger"]:checked')).map(el => el.value),
    };

    this._saveFilters();
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

  _renderList() {
    const listPanel = this.shadowRoot.getElementById('listPanel');
    if (!listPanel) return;

    if (!this._recordings.length) {
      listPanel.innerHTML = '<div class="list-msg">No recordings found</div>';
      this._updateNavButtons();
      return;
    }

    listPanel.innerHTML = this._recordings.map((rec, i) => this._recItemHTML(rec, i)).join('');

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

  /** Index of the next-older recording, or -1 if none. */
  _olderIndex() {
    if (this._selectedIndex < 0) return -1;
    const i = this._filters.sortDesc ? this._selectedIndex + 1 : this._selectedIndex - 1;
    return (i >= 0 && i < this._recordings.length) ? i : -1;
  }

  /** Index of the next-newer recording, or -1 if none. */
  _newerIndex() {
    if (this._selectedIndex < 0) return -1;
    const i = this._filters.sortDesc ? this._selectedIndex - 1 : this._selectedIndex + 1;
    return (i >= 0 && i < this._recordings.length) ? i : -1;
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
