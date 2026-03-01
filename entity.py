"""Base entity for dragontree_reolink."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.core import callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo, Entity

from .const import DOMAIN, SIGNAL_UPDATE

if TYPE_CHECKING:
    from .coordinator import ReolinkDownloadCoordinator


class DragontreeReolinkEntity(Entity):
    """Base class for all dragontree_reolink entities.

    Provides shared device_info, polling=False, and automatic wiring to the
    SIGNAL_UPDATE dispatcher so every entity refreshes when the coordinator
    pushes a change.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        self._coordinator = coordinator
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.config_entry.entry_id)},
            name="Dragontree Reolink",
            manufacturer="Dragontree",
            model="Reolink Downloader",
        )

    async def async_added_to_hass(self) -> None:
        """Subscribe to coordinator update signals."""
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATE, self._handle_update)
        )

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()
