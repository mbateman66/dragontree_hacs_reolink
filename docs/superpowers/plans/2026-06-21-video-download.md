# Video Download / Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a download/share button to the playback card controls bar that saves the current recording — using the native share sheet on iOS/macOS Safari, and a direct download on Chrome/Firefox/Edge.

**Architecture:** All changes are in one file (`dragontree-reolink-cards.js`). The resolved media URL is cached on the card instance when playback starts and cleared when a new recording is selected. The download handler reads from that cache and branches on `navigator.share` availability.

**Tech Stack:** Vanilla JS Web Component, HA Lovelace custom card, `navigator.share` Web Share API, programmatic anchor-click fallback.

---

## File Map

| File | Changes |
|---|---|
| `/mnt/ha-dev/config/custom_components/dragontree_reolink/js/dragontree-reolink-cards.js` | All changes — HTML template, constructor, `_selectRecording`, `_playUrl`, `_updateNavButtons`, event binding, new `_downloadCurrent` method |

No Python changes required. No new files.

---

### Task 1: Add button to HTML template and initialize `_currentUrl`

**Files:**
- Modify: `dragontree-reolink-cards.js:487-492` (HTML template controls row)
- Modify: `dragontree-reolink-cards.js:534-549` (constructor)

> Note: there is no test framework for this Lovelace card. Each task ends with a manual smoke check instead of an automated test run.

- [ ] **Step 1: Add `btnDownload` to the controls-row HTML template**

Find this block (around line 487):
```js
          <div class="ctrl-spacer"></div>
          <button class="ctrl-btn icon-only" id="btnMute">
            <ha-icon icon="mdi:volume-high" style="--mdc-icon-size:18px"></ha-icon>
          </button>
```

Replace with:
```js
          <div class="ctrl-spacer"></div>
          <button class="ctrl-btn icon-only" id="btnDownload" disabled>
            <ha-icon icon="mdi:download" style="--mdc-icon-size:18px"></ha-icon>
          </button>
          <button class="ctrl-btn icon-only" id="btnMute">
            <ha-icon icon="mdi:volume-high" style="--mdc-icon-size:18px"></ha-icon>
          </button>
```

- [ ] **Step 2: Initialize `_currentUrl` in constructor**

Find this block in `constructor()` (around line 545):
```js
    this._thumbCache = new Map(); // content_id → resolved URL
```

Add one line after it:
```js
    this._thumbCache = new Map(); // content_id → resolved URL
    this._currentUrl = null;
```

- [ ] **Step 3: Manual smoke check**

Reload the card in the browser (hard-refresh or clear cache). The download button should appear to the left of the mute button, be visually disabled (greyed out), and the mute/fullscreen buttons should look unchanged.

- [ ] **Step 4: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "Add download button to controls bar HTML, initialize _currentUrl"
```

---

### Task 2: Cache and reset the resolved URL

**Files:**
- Modify: `dragontree-reolink-cards.js:1050` (`_selectRecording`)
- Modify: `dragontree-reolink-cards.js:1081` (`_playUrl`)

- [ ] **Step 1: Reset `_currentUrl` at the start of `_selectRecording`**

Find the start of `_selectRecording` (around line 1050):
```js
  async _selectRecording(index) {
    this._selectedIndex = index;
    const rec = this._recordings[index];
    if (!rec) return;
```

Replace with:
```js
  async _selectRecording(index) {
    this._selectedIndex = index;
    this._currentUrl = null;
    const rec = this._recordings[index];
    if (!rec) return;
```

- [ ] **Step 2: Cache URL in `_playUrl`**

Find the first line of `_playUrl` (around line 1081):
```js
  _playUrl(url) {
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    videoArea.innerHTML = `<video autoplay playsinline src="${url}"></video>`;
```

Replace with:
```js
  _playUrl(url) {
    this._currentUrl = url;
    const videoArea = this.shadowRoot.getElementById('videoArea');
    if (!videoArea) return;
    videoArea.innerHTML = `<video autoplay playsinline src="${url}"></video>`;
```

- [ ] **Step 3: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "Cache resolved URL in _playUrl, reset in _selectRecording"
```

---

### Task 3: Wire `btnDownload` into `_updateNavButtons`

**Files:**
- Modify: `dragontree-reolink-cards.js:1144` (`_updateNavButtons`)

- [ ] **Step 1: Add `btnDownload` disable logic**

Find `_updateNavButtons` (around line 1144):
```js
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
```

Replace with:
```js
  _updateNavButtons() {
    const sr = this.shadowRoot;
    const prev = sr.getElementById('btnPrev');
    const next = sr.getElementById('btnNext');
    const fs = sr.getElementById('btnFullscreen');
    const dl = sr.getElementById('btnDownload');
    const seek = sr.getElementById('seekBar');
    const hasContent = this._selectedIndex >= 0;
    if (prev) prev.disabled = this._olderIndex() === -1;
    if (next) next.disabled = this._newerIndex() === -1;
    if (fs) fs.disabled = !hasContent;
    if (dl) dl.disabled = !hasContent;
    if (seek) seek.disabled = !hasContent;
```

- [ ] **Step 2: Manual smoke check**

Reload the card. With no recording selected, the download button should be disabled (greyed). Click any recording in the list — the button should become enabled immediately (before the video finishes loading), since `hasContent` is based on `_selectedIndex >= 0`.

- [ ] **Step 3: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "Enable/disable btnDownload in _updateNavButtons"
```

---

### Task 4: Implement `_downloadCurrent` and bind the click handler

**Files:**
- Modify: `dragontree-reolink-cards.js` — new method after `_playUrl`, click listener near line 883

- [ ] **Step 1: Add `_downloadCurrent` method after `_playUrl`**

Find the end of `_playUrl` (around line 1117):
```js
    this._updateMuteButton();
    this._updatePlayPauseButton();
  }

  _updatePlayPauseButton() {
```

Insert after the closing `}` of `_playUrl`:
```js
    this._updateMuteButton();
    this._updatePlayPauseButton();
  }

  _downloadCurrent() {
    if (!this._currentUrl) return;
    const rec = this._recordings[this._selectedIndex];
    if (!rec) return;
    const url = this._currentUrl.startsWith('/')
      ? window.location.origin + this._currentUrl
      : this._currentUrl;
    const camera = rec.camera.replace(/[\s/]+/g, '_');
    const d = new Date(rec.start_time);
    const pad = n => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const filename = `${camera}_${ts}.mp4`;
    if (navigator.share) {
      navigator.share({ url, title: filename }).catch(e => {
        if (e.name !== 'AbortError') console.error('[reolink] share failed', e);
      });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    }
  }

  _updatePlayPauseButton() {
```

- [ ] **Step 2: Bind the click handler**

Find the block that ends with `this._bindPlayerButtons()` (around line 883):
```js
    // PlayerMixin shared button bindings (mute + fullscreen)
    this._bindPlayerButtons();
  }
```

Replace with:
```js
    sr.getElementById('btnDownload').addEventListener('click', () => this._downloadCurrent());

    // PlayerMixin shared button bindings (mute + fullscreen)
    this._bindPlayerButtons();
  }
```

- [ ] **Step 3: Manual test — desktop (Chrome/Firefox/Edge)**

Reload the card. Select a recording, wait for it to load. Click the download button. Expected: browser initiates a file download named `{Camera}_{YYYY-MM-DD_HH-MM-SS}.mp4`.

- [ ] **Step 4: Manual test — iOS Safari (or macOS Safari)**

Open the HA dashboard in Safari on an iPhone, iPad, or Mac. Select a recording. Tap the download button. Expected: the native iOS/macOS share sheet appears. Tap "Save to Files" or "Save Video" — the file should appear in Files / Photos.

- [ ] **Step 5: Manual test — edge cases**

  - Click download while no recording is selected (button should be disabled — can't click).
  - Click download immediately after selecting a new recording, before the video loads (handler guard `if (!this._currentUrl) return` should silently do nothing).
  - Dismiss the share sheet on iOS without saving — no error should appear.

- [ ] **Step 6: Commit**

```bash
git -C /home/mdb/dev/dragontree_reolink add js/dragontree-reolink-cards.js
git -C /home/mdb/dev/dragontree_reolink commit -m "Add _downloadCurrent handler and btnDownload click binding"
```

---

### Task 5: Sync to HA config and cut release

- [ ] **Step 1: Sync JS to mounted HA config**

```bash
cp /home/mdb/dev/dragontree_reolink/js/dragontree-reolink-cards.js \
   /mnt/ha-dev/config/custom_components/dragontree_reolink/js/dragontree-reolink-cards.js
```

- [ ] **Step 2: Validate on the test HA instance**

Open the Reolink playback card on the test HA instance (SSH to `.50` if needed). Confirm the download button works end-to-end: select a recording, download it, verify the file is valid and correctly named.

- [ ] **Step 3: Cut the HACS release**

Use the `release-hacs-component` skill (version bump → changelog → commit → tag → push → GitHub Release).
