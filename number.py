"""Number entities for dragontree_reolink."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.number import NumberEntity, NumberMode

from .const import CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB
from .entity import DragontreeReolinkEntity

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import ReolinkDownloadCoordinator
    from .data import DragontreeReolinkConfigEntry


async def async_setup_entry(
    hass: HomeAssistant,  # noqa: ARG001
    entry: DragontreeReolinkConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up number entities."""
    async_add_entities([MaxDiskGbNumber(entry.runtime_data.coordinator)])


class MaxDiskGbNumber(DragontreeReolinkEntity, NumberEntity):
    """Configurable max disk space for local recordings."""

    _attr_icon = "mdi:harddisk"
    _attr_native_min_value = 1
    _attr_native_max_value = 500
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "GB"
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_max_disk_gb"
        self._attr_name = "Max Disk Space"

    @property
    def native_value(self) -> int:
        return self._coordinator.config_entry.options.get(
            CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB
        )

    async def async_set_native_value(self, value: float) -> None:
        new_options = {
            **self._coordinator.config_entry.options,
            CONF_MAX_DISK_GB: int(value),
        }
        self.hass.config_entries.async_update_entry(
            self._coordinator.config_entry, options=new_options
        )
