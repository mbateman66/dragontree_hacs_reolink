# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

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
