# Video Download / Share — Design Spec

Date: 2026-06-21

## Overview

Add a download/share button to the playback card's controls bar so users can save the currently playing recording to their device. Must work on Mac, Windows, iOS (iPhone/iPad).

## Button Placement

Insert an icon-only button (`mdi:download`, id `btnDownload`) in the `.controls-row`, immediately to the left of the mute button (`btnMute`). Final right-side order: `[spacer] | Download | Mute | Fullscreen`.

Styling: same `.ctrl-btn.icon-only` class as mute and fullscreen buttons. Disabled state matches existing pattern — disabled when no recording is selected or no URL is cached yet.

## URL Caching

`_playUrl(url)` already receives the resolved media URL. Store it on the instance as `this._currentUrl = url`. The download handler reads from `this._currentUrl`.

Reset `this._currentUrl = null` at the **start** of `_selectRecording()`, before the async `media_source/resolve_media` call. This ensures that if URL resolution fails, no stale URL from the previous recording is left behind. The handler's `if (!this._currentUrl) return` guard catches the window between selection and resolution completing.

Make the URL absolute before using it: if `this._currentUrl` starts with `/`, prepend `window.location.origin`.

## Filename

Construct from the current recording's metadata:

```
{camera}_{YYYY-MM-DD_HH-MM-SS}.mp4
```

- `camera` from `this._recordings[this._selectedIndex].camera` — sanitize to filesystem-safe chars (replace spaces and `/` with `_`)
- Timestamp from `rec.start_time` — formatted as `YYYY-MM-DD_HH-MM-SS` in local time

Example: `Backyard_2026-06-21_14-32-05.mp4`

## Platform Logic

```
_downloadCurrent() {
  if (!this._currentUrl) return;
  const url = this._currentUrl.startsWith('/')
    ? window.location.origin + this._currentUrl
    : this._currentUrl;
  const filename = <derived from rec>;

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
```

- `navigator.share` is available on iOS Safari and macOS Safari — both get the native share sheet.
- All other browsers (Chrome, Firefox, Edge on Mac/Windows) get the silent anchor-click download.
- `AbortError` is silently ignored (user dismissed the share sheet).

## Button State

`_updateControls()` already enables/disables buttons based on `hasContent`. Extend it to also enable/disable `btnDownload` using the same `hasContent` flag.

`hasContent` is true when a video is loaded and ready. `this._currentUrl` will be set by then, so no separate null-check is needed in the handler beyond the guard at the top of `_downloadCurrent`.

## Out of Scope

- Blob fetching / in-memory download (rejected: memory risk for large files)
- Progress indicator during share
- Batch download of multiple recordings
