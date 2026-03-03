# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-03-03

### Added
- **Camera Schedule card** (`dragontree-reolink-schedule`): configure a daily
  on/off schedule for cameras with a schedule-enabled toggle and start/stop
  time pickers. Settings are persisted in HA storage and survive restarts.
- **Camera Management card** (`dragontree-reolink-cameras`): one row per
  Reolink camera with: PIR-enabled toggle (`*_pir_enabled`), reduce-false-alarm
  toggle (`*_pir_reduce_false_alarm`), sensitivity slider (`*_pir_sensitivity`),
  and an "include in schedule" toggle. All controls read/write the corresponding
  HA entities directly.
- New WebSocket commands: `dragontree_reolink/get_cameras_config`,
  `dragontree_reolink/set_camera_in_schedule`, `dragontree_reolink/get_schedule`,
  `dragontree_reolink/set_schedule`.
- Schedule enforcement: at the configured start time the integration calls
  `switch.turn_on` for all in-schedule cameras; at the stop time it calls
  `switch.turn_off`. Overnight windows (e.g. 22:00 → 06:00) are handled
  correctly. On integration startup the schedule is applied immediately if
  it is active.

### Changed
- Status & Configuration view and Camera Management view merged into a single
  **Status & Cameras** view (icon `mdi:gauge`), reducing dashboard tab count.
- Schedule and cameras cards now use `ha-card` and `ha-switch` — the same
  elements used by the built-in entities card — for visual consistency with
  the rest of the HA UI.
- "Include in schedule" defaults to off for newly discovered cameras; must
  be explicitly enabled per camera.

### Fixed
- Toggle switches in the cameras card no longer revert momentarily after being
  clicked. A per-entity suppression window prevents `_syncStates()` from
  overwriting optimistic UI updates during the service call round-trip.

## [1.2.7] - 2026-03-02

### Fixed
- On iPhone portrait mode the entire page scrolled instead of just the recording
  list, causing the media player and filter panel to scroll off-screen. The mobile
  layout now constrains the card to the viewport height (`100dvh - 56px`) and uses
  `grid-template-rows: auto 1fr` so the right panel fills remaining space. The video
  wrapper gains `aspect-ratio: 16/9` so the player panel has a natural height without
  requiring a flex parent constraint.

## [1.2.6] - 2026-03-02

### Added
- Recording list now lazy-loads: starts with the 50 most recent recordings and
  fetches the next page automatically when the user scrolls to the end of the list.
- Filter settings (camera and tag selections, filter panel open/closed state) now
  persist permanently per HA user account via `frontend/set_user_data` — survive
  browser closes, device switches, and HA restarts. `sessionStorage` is used as an
  instant fast-path on load.

### Changed
- Date range filter removed from the filter panel; the list now always starts from
  the most recent recordings with no upper/lower bound required.
- Sort order option removed; list is always newest-first.
- Filter changes take effect immediately on checkbox toggle — Apply button removed.

### Fixed
- `database.py` `query()` gained `limit`, `before_dt`, and `after_dt` parameters to
  support cursor-based pagination without re-fetching already-loaded rows.

## [1.2.5] - 2026-03-02

### Fixed
- Dashboard panel registration now uses `update=True` so the integration can be
  reloaded without crashing with `ValueError: Overwriting panel`.
- If post-platform setup fails, platforms are now torn down immediately so a
  subsequent reload does not encounter "already been setup" errors.
- `async_unload_entry` is now fully defensive and handles being called on a
  partially-loaded entry where `runtime_data` was never assigned.

## [1.2.4] - 2026-03-02

### Fixed
- Lovelace card JS is now registered via Lovelace's `ResourceStorageCollection` API
  instead of `add_extra_js_url`. This keeps the in-memory resource collection, the
  storage file, and all connected clients in sync via WebSocket push — previously the
  card could fail to load after a fresh install without a full browser reload.
- Any stale `/local/*` resource entries written by earlier versions are cleaned up
  automatically on first run after upgrading.

## [1.2.3] - 2026-03-01

### Fixed
- Fixed `ValueError: Invalid datetime ... missing timezone information` crash on the
  `last_download` sensor — `_load_from_db` was stripping the timezone from the stored
  timestamp; `SensorDeviceClass.TIMESTAMP` requires a timezone-aware datetime.

## [1.2.2] - 2026-03-01

### Added
- Playback list updates automatically when new recordings finish downloading —
  no page refresh required. Uses an HA event bus subscription so the list
  refreshes in real time while preserving the currently selected recording.

### Changed
- Camera name font size increased slightly; time-of-day now matches that size
  at normal weight so it reads lighter than the camera name.

### Fixed
- Eliminated "blocking call" warning in HA logs — manifest.json is now read
  once at module import time instead of inside the async event loop.

## [1.2.1] - 2026-03-01

### Changed
- Playback list: time of day is now displayed above the tag badges (right column),
  at normal font size/weight; date and duration remain in the left info column
- Prev/Next navigation buttons (and auto-advance on playback end) now always move
  backward/forward in time regardless of the current sort order

## [1.2.0] - 2026-03-01

### Changed
- Refactored to follow the official HA integration blueprint conventions:
  - `data.py` — new `DragontreeReolinkData` dataclass + typed `DragontreeReolinkConfigEntry`
    alias (`ConfigEntry[DragontreeReolinkData]`); `entry.runtime_data` is now typed
  - `entity.py` — new `DragontreeReolinkEntity` base class; deduplicates `device_info`,
    `has_entity_name`, `should_poll`, and dispatcher wiring across all platforms
  - `const.py` — `LOGGER` via `getLogger(__package__)`; all modules now import this
    single logger instead of creating per-module `_LOGGER` instances
  - `sensor.py` / `number.py` — use typed config entry, access coordinator via
    `entry.runtime_data.coordinator`, extend `DragontreeReolinkEntity`
  - `config_flow.py` — `ConfigFlowResult` return type; `selector.NumberSelector` and
    `selector.SelectSelector` for form fields; modern `OptionsFlow` pattern (no custom
    `__init__`, accesses `self.config_entry` directly)
  - `Platform` enum used in `PLATFORMS` list; `HomeAssistant` imported under
    `TYPE_CHECKING` throughout

## [1.1.0] - 2026-03-01

### Changed
- Dashboard is now registered automatically in the HA sidebar — no `configuration.yaml`
  edits required. Uses `LovelaceYAML` + `_register_panel` to serve the bundled YAML
  directly from the integration package.
- Lovelace card JS is now registered via `add_extra_js_url` instead of the
  `.storage/lovelace_resources` file. Any stale resource entries are cleaned up
  automatically on first run after upgrading.
- Added `"dependencies": ["lovelace", "http", "frontend"]` to `manifest.json` to
  guarantee these HA subsystems are ready before setup.
- Dashboard and JS files are now organised into `lovelace/` and `js/` subdirectories.

### Removed
- Dashboard file copy and persistent notification on first install (superseded by
  automatic dashboard registration).

## [1.0.1] - 2026-03-01

### Fixed
- Dashboard YAML is now automatically copied to `dashboards/dragontree_reolink_cameras.yaml`
  in the HA config directory on first setup, and a persistent notification provides the exact
  `configuration.yaml` snippet to add — no manual file-path hunting after a HACS install

## [1.0.0] - 2026-02-28

### Added
- Initial release
- Downloads recordings from Reolink cameras to local media storage
- Motion-triggered downloads with configurable delays
- Periodic polling (60 s) as a safety net
- SQLite metadata database with AI trigger tags (ANIMAL, VEHICLE, PERSON)
- Full-size and thumbnail JPEG extraction for each recording (requires `av`)
- Disk space management — oldest recordings deleted when limit is exceeded
- `number` entity for configuring max disk space (default 5 GB)
- Sensors: disk used, queue size, total recordings, last download
- WebSocket API: `dragontree_reolink/get_recordings`, `dragontree_reolink/get_cameras`
- Lovelace card `dragontree-reolink-playback` — 3-panel recording browser
  with video player, collapsible filter panel, and scrollable recording list
- Bundled card JS served automatically; Lovelace resource auto-registered on setup
