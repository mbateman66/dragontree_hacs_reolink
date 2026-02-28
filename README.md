# Dragontree Reolink

A Home Assistant custom integration that mirrors Reolink camera recordings to
local media storage, with a built-in Lovelace recording browser.

## Features

- Downloads recordings from all Reolink cameras to `/media/Dragontree/Reolink/`
- Motion-triggered downloads (accounts for post-motion recording extension)
- 60-second background polling as a safety net
- AI trigger metadata stored per recording (ANIMAL, VEHICLE, PERSON)
- Full-size and thumbnail JPEG extracted from each recording
- Disk space limit — oldest recordings deleted automatically when limit is hit
- Lovelace recording browser with video player, filters, and thumbnail list

## Requirements

- Home Assistant 2024.1 or newer
- The built-in [Reolink integration](https://www.home-assistant.io/integrations/reolink/)
  must be configured first
- Cameras must support VOD replay (most Reolink hub and NVR cameras do)

## Installation via HACS

1. In HACS, go to **Integrations → Custom repositories**
2. Add `https://github.com/mbateman66/dragontree_hacs_reolink` with category **Integration**
3. Search for **Dragontree Reolink** and install it
4. Restart Home Assistant

## Post-install setup

### 1. Add the integration

**Settings → Devices & Services → Add Integration → Dragontree Reolink**

Configure:
- **Max disk space** — maximum GB to use for recordings (default: 5 GB)
- **Stream** — `main` (full quality) or `sub` (lower quality, smaller files)

### 2. Add the Cameras dashboard

The Lovelace card and WebSocket API are registered automatically on startup.
The dashboard YAML is provided in `resources/dashboards/cameras.yaml`.
Add it to your `configuration.yaml`:

```yaml
lovelace:
  dashboards:
    cameras-yaml:
      mode: yaml
      title: Cameras
      icon: mdi:cctv
      filename: <path_to>/cameras.yaml
      show_in_sidebar: true
```

### 3. Allow media directory access

In `configuration.yaml`:

```yaml
homeassistant:
  allowlist_external_dirs:
    - "/media"
```

Restart Home Assistant after making configuration changes.

## Releasing a new version

1. Make and commit your changes
2. Update the version in `manifest.json`:
   ```json
   { "version": "1.1.0" }
   ```
3. Add an entry to `CHANGELOG.md`
4. Commit, tag, and push:
   ```bash
   git add manifest.json CHANGELOG.md
   git commit -m "Release v1.1.0"
   git tag v1.1.0
   git push && git push --tags
   ```
5. On GitHub, create a **Release** from the tag — HACS picks this up and
   notifies users of the update

> The Lovelace card is cache-busted automatically using the version number,
> so users get the new JS on their next browser reload after updating.
