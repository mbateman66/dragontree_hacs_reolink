"""Dragontree Reolink — local recording downloader.

This integration hooks into all loaded Reolink config entries and mirrors
recordings to /media/Dragontree/Reolink using the same camera/date folder
structure exposed by the Reolink media source.

Key behaviour:
- On setup: downloads the 2 most recent recordings from each camera.
- Polling: checks for new recordings every 5 minutes.
- Motion-triggered: re-checks a channel 60 s after a motion/AI event fires
  (allowing the camera to finish writing the clip).
- One download at a time via an asyncio queue.
- Disk limit: oldest recordings are deleted when the limit would be exceeded.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .api import async_register_ws_commands
from .const import DOMAIN
from .coordinator import ReolinkDownloadCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["number", "sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Dragontree Reolink from a config entry."""
    coordinator = ReolinkDownloadCoordinator(hass, entry)
    entry.runtime_data = coordinator

    # Store coordinator for WebSocket API access (single-entry integration)
    hass.data[DOMAIN] = coordinator

    await coordinator.async_initialize()

    # Register WS commands once; safe to call on each reload
    async_register_ws_commands(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

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
