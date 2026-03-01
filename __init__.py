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

from homeassistant.components.frontend import add_extra_js_url, async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import _register_panel
from homeassistant.components.lovelace.dashboard import LovelaceYAML
from homeassistant.const import Platform
from homeassistant.helpers.storage import Store

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

    # Register the Lovelace card JS module
    _register_frontend(hass)

    # Register the Cameras dashboard in the HA sidebar
    _register_dashboard(hass)

    # One-time migration: remove stale /local/* entries from lovelace_resources store
    await _cleanup_old_lovelace_resource(hass)

    # Re-run initialisation when options change (max_disk_gb / stream)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: DragontreeReolinkConfigEntry) -> bool:
    """Unload a config entry."""
    await entry.runtime_data.coordinator.async_unload()

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


def _register_frontend(hass: HomeAssistant) -> None:
    """Register the bundled Lovelace card JS as a frontend module.

    add_extra_js_url injects the URL into every Lovelace page load — equivalent
    to a resources entry but done entirely at runtime, no storage file needed.
    """
    url = f"{_JS_URL_BASE}/dragontree-reolink-cards.js?v={_VERSION}"
    add_extra_js_url(hass, url)
    LOGGER.debug("Registered Lovelace card module: %s", url)


def _register_dashboard(hass: HomeAssistant) -> None:
    """Register the Cameras YAML dashboard in the HA sidebar.

    Uses LovelaceYAML to point directly at the bundled YAML inside the
    integration package — no file copying required.  _register_panel with
    update=False is a no-op if the panel is already registered, so this is
    safe to call on every entry reload.
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
    _register_panel(hass, _DASHBOARD_URL, "yaml", config, False)
    LOGGER.info("Cameras dashboard registered at /%s", _DASHBOARD_URL)


async def _cleanup_old_lovelace_resource(hass: HomeAssistant) -> None:
    """Remove stale /local/* resource entries for this integration.

    Previous versions stored the card URL in .storage/lovelace_resources.
    That approach is replaced by add_extra_js_url — this function removes
    any leftover entries on the first run after upgrading.
    """
    store = Store(hass, 1, "lovelace_resources", minor_version=1)
    data = await store.async_load()
    if data is None:
        return

    items: list[dict] = data.get("items", [])
    cleaned = [
        i for i in items
        if not ("dragontree" in i.get("url", "") and "reolink" in i.get("url", ""))
    ]
    if len(cleaned) != len(items):
        await store.async_save({"items": cleaned})
        LOGGER.info(
            "Removed %d stale lovelace_resources entry(s) for %s",
            len(items) - len(cleaned),
            DOMAIN,
        )
