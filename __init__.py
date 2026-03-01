"""Dragontree Reolink — local recording downloader.

This integration hooks into all loaded Reolink config entries and mirrors
recordings to /media/Dragontree/Reolink using the same camera/date folder
structure exposed by the Reolink media source.

Key behaviour:
- On setup: downloads the 2 most recent recordings from each camera.
- Polling: checks for new recordings every 60 seconds.
- Motion-triggered: re-checks a channel after motion ends, accounting for
  Reolink's post-motion recording extension and hub finalization delay.
- One download at a time via an asyncio queue.
- Disk limit: oldest recordings are deleted when the limit would be exceeded.
- Frame extraction: full-size and thumbnail JPEGs are created for each recording.

The Lovelace card (dragontree-reolink-playback) is served automatically from
the integration package and registered as a Lovelace resource on first setup.
"""

from __future__ import annotations

import json
import logging
import shutil
import uuid
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.persistent_notification import async_create as pn_create
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .api import async_register_ws_commands
from .const import DOMAIN
from .coordinator import ReolinkDownloadCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["number", "sensor"]

# URL at which the bundled Lovelace card is served
_CARD_URL = f"/{DOMAIN}/cards.js"
_CARD_PATH = Path(__file__).parent / "resources" / "cards" / "dragontree-reolink-cards.js"


def _integration_version() -> str:
    """Read the version from manifest.json."""
    try:
        manifest = json.loads((Path(__file__).parent / "manifest.json").read_text())
        return manifest.get("version", "0.0.0")
    except Exception:
        return "0.0.0"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the bundled Lovelace card as a static HTTP path.

    This runs once when HA loads the integration domain, before any config
    entries are set up.
    """
    if _CARD_PATH.exists():
        await hass.http.async_register_static_paths(
            [StaticPathConfig(_CARD_URL, str(_CARD_PATH), cache_headers=True)]
        )
        _LOGGER.debug("Registered static path %s → %s", _CARD_URL, _CARD_PATH)
    else:
        _LOGGER.warning(
            "Card file not found at %s — Lovelace card will not be available", _CARD_PATH
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Dragontree Reolink from a config entry."""
    coordinator = ReolinkDownloadCoordinator(hass, entry)
    entry.runtime_data = coordinator

    # Store coordinator for WebSocket API access (single-entry integration)
    hass.data[DOMAIN] = coordinator

    await coordinator.async_initialize()

    # Register WS commands; safe to call on each reload
    async_register_ws_commands(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Auto-register the Lovelace resource so no manual step is needed
    await _ensure_lovelace_resource(hass, _integration_version())

    # Copy dashboard YAML to config dir and notify user on first install
    await _ensure_dashboard_file(hass)

    # Re-run initialisation when options change (max_disk_gb / stream)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    coordinator: ReolinkDownloadCoordinator = entry.runtime_data
    await coordinator.async_unload()

    hass.data.pop(DOMAIN, None)

    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update — reload the entry to apply new settings."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _ensure_lovelace_resource(hass: HomeAssistant, version: str) -> None:
    """Add or update the Lovelace card resource in .storage/lovelace_resources.

    - On first install: adds the resource entry.
    - On version update: updates the URL so the browser fetches the new file.
    - Migrates any old resource URL (e.g. /local/dragontree-reolink-cards.js).
    - No-ops if already up to date.

    Takes effect on the next browser reload (or full HA restart in some configs).
    """
    resource_url = f"{_CARD_URL}?v={version}"
    store = Store(hass, 1, "lovelace_resources", minor_version=1)
    data = await store.async_load()

    if data is None:
        # File doesn't exist — Lovelace is probably in YAML resource mode.
        _LOGGER.info(
            "Lovelace resource store not found (YAML mode?). "
            "Add this resource manually: %s  type: module",
            resource_url,
        )
        return

    items: list[dict] = data.get("items", [])

    # Remove any previous entries for this card (handles URL migrations)
    items = [
        i for i in items
        if not ("dragontree" in i.get("url", "") and "reolink" in i.get("url", ""))
    ]

    items.append({"id": uuid.uuid4().hex, "url": resource_url, "type": "module"})
    await store.async_save({"items": items})

    _LOGGER.info("Lovelace card resource registered: %s", resource_url)


# Destination path relative to the HA config directory
_DASHBOARD_DST = "dashboards/dragontree_reolink_cameras.yaml"

_DASHBOARD_NOTIFICATION = """\
The Dragontree Reolink dashboard has been copied to `{dst}`.

Add the following to your `configuration.yaml` and restart Home Assistant:

```yaml
lovelace:
  dashboards:
    cameras-yaml:
      mode: yaml
      title: Cameras
      icon: mdi:cctv
      filename: {dst}
      show_in_sidebar: true
```
"""


async def _ensure_dashboard_file(hass: HomeAssistant) -> None:
    """Copy the bundled dashboard YAML to the HA config directory.

    Only runs on first install (skips if the destination already exists so user
    customisations are never overwritten).  Creates a persistent notification
    with the exact configuration.yaml snippet the user needs to add.
    """
    src = Path(__file__).parent / "resources" / "dashboards" / "cameras.yaml"
    dst = Path(hass.config.config_dir) / _DASHBOARD_DST

    if dst.exists():
        return

    try:
        await hass.async_add_executor_job(dst.parent.mkdir, 0o755, True, True)
        await hass.async_add_executor_job(shutil.copy, str(src), str(dst))
    except Exception as err:
        _LOGGER.warning("Could not copy dashboard YAML: %s", err)
        return

    _LOGGER.info("Dashboard YAML copied to %s", dst)
    pn_create(
        hass,
        message=_DASHBOARD_NOTIFICATION.format(dst=_DASHBOARD_DST),
        title="Dragontree Reolink — Dashboard Setup Required",
        notification_id=f"{DOMAIN}_dashboard_setup",
    )
