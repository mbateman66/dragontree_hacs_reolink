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
the integration package and registered as a frontend module on first setup.
The Cameras dashboard is registered in the HA sidebar automatically.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import _register_panel
from homeassistant.components.lovelace.dashboard import LovelaceYAML
from homeassistant.const import Platform

from .api import async_register_ws_commands
from .const import DOMAIN, LOGGER
from .coordinator import ReolinkDownloadCoordinator
from .data import DragontreeReolinkData

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant

    from .data import DragontreeReolinkConfigEntry

PLATFORMS: list[Platform] = [Platform.NUMBER, Platform.SENSOR]

# URL path where the bundled JS directory is served
_JS_URL_BASE = f"/{DOMAIN}/js"
_JS_DIR = Path(__file__).parent / "js"

# Lovelace dashboard slug and YAML path (relative to HA config dir)
_DASHBOARD_URL = "dragontree-reolink"
_DASHBOARD_YAML = f"custom_components/{DOMAIN}/lovelace/ui-lovelace.yaml"

# Read version once at import time — manifest.json is static while HA is running.
try:
    _VERSION = json.loads((Path(__file__).parent / "manifest.json").read_text()).get("version", "0.0.0")
except Exception:
    _VERSION = "0.0.0"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Serve the bundled JS directory as a static HTTP path.

    This runs once when HA loads the integration domain, before any config
    entries are set up.
    """
    if _JS_DIR.exists():
        await hass.http.async_register_static_paths(
            [StaticPathConfig(_JS_URL_BASE, str(_JS_DIR), cache_headers=True)]
        )
        LOGGER.debug("Registered static path %s → %s", _JS_URL_BASE, _JS_DIR)
    else:
        LOGGER.warning(
            "JS directory not found at %s — Lovelace card will not be available",
            _JS_DIR,
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: DragontreeReolinkConfigEntry) -> bool:
    """Set up Dragontree Reolink from a config entry."""
    coordinator = ReolinkDownloadCoordinator(hass, entry)
    entry.runtime_data = DragontreeReolinkData(coordinator=coordinator)

    # Store runtime_data for WebSocket API access (WS handlers receive hass, not entry)
    hass.data[DOMAIN] = entry.runtime_data

    await coordinator.async_initialize()

    # Register WS commands; safe to call on each reload
    async_register_ws_commands(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    try:
        # Register the Lovelace card JS in lovelace_resources (Lovelace waits for these before rendering)
        await _ensure_lovelace_resource(hass)

        # Register the Cameras dashboard in the HA sidebar
        _register_dashboard(hass)

        # Re-run initialisation when options change (max_disk_gb / stream)
        entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    except Exception:
        # If post-platform setup fails, tear down the platforms we already set up
        # so that a subsequent reload doesn't hit "already been setup" errors.
        await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
        hass.data.pop(DOMAIN, None)
        raise

    return True


async def async_unload_entry(hass: HomeAssistant, entry: DragontreeReolinkConfigEntry) -> bool:
    """Unload a config entry."""
    runtime_data = getattr(entry, "runtime_data", None)
    if runtime_data is not None:
        await runtime_data.coordinator.async_unload()

    hass.data.pop(DOMAIN, None)

    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: DragontreeReolinkConfigEntry) -> None:
    """Remove the dashboard panel when the integration is deleted."""
    try:
        async_remove_panel(hass, _DASHBOARD_URL)
    except Exception:
        pass
    lovelace = hass.data.get("lovelace")
    if lovelace is not None:
        lovelace.dashboards.pop(_DASHBOARD_URL, None)


async def _async_options_updated(hass: HomeAssistant, entry: DragontreeReolinkConfigEntry) -> None:
    """Handle options update — reload the entry to apply new settings."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Register the card JS via Lovelace's ResourceStorageCollection.

    Writing directly to the Store file only updates the JSON on disk — it
    bypasses HA's in-memory resource collection and never sends a WebSocket
    push to connected frontends.  Using the collection API keeps the in-memory
    state, the storage file, and all connected clients in sync.

    The collection's async_create_item() expects "res_type" (the WS field name),
    which is internally converted to "type" when stored.
    """
    url = f"{_JS_URL_BASE}/dragontree-reolink-cards.js?v={_VERSION}"
    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        LOGGER.warning("Lovelace not initialised — cannot register resource")
        return

    resources = getattr(lovelace, "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        LOGGER.warning("Lovelace resource collection not available (resource_mode may not be storage)")
        return

    # Remove any existing entries for this integration (old version or old path)
    for item in list(resources.async_items()):
        item_url = item.get("url", "")
        if _JS_URL_BASE in item_url or "dragontree-reolink" in item_url:
            try:
                await resources.async_delete_item(item["id"])
            except Exception:
                pass

    await resources.async_create_item({"res_type": "module", "url": url})
    LOGGER.info("Registered Lovelace resource: %s", url)


def _register_dashboard(hass: HomeAssistant) -> None:
    """Register the Cameras YAML dashboard in the HA sidebar.

    Uses LovelaceYAML to point directly at the bundled YAML inside the
    integration package — no file copying required.  _register_panel with
    update=True overwrites any existing registration, making this safe to
    call on every entry reload without raising ValueError.
    """
    lovelace = hass.data.get("lovelace")
    if lovelace is None:
        LOGGER.warning("Lovelace not initialised — Cameras dashboard not registered")
        return

    config = {
        "mode": "yaml",
        "icon": "mdi:cctv",
        "title": "Cameras",
        "filename": _DASHBOARD_YAML,
        "show_in_sidebar": True,
        "require_admin": False,
    }

    lovelace.dashboards[_DASHBOARD_URL] = LovelaceYAML(hass, _DASHBOARD_URL, config)
    _register_panel(hass, _DASHBOARD_URL, "yaml", config, True)
    LOGGER.info("Cameras dashboard registered at /%s", _DASHBOARD_URL)


