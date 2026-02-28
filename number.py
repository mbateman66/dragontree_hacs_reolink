"""Number entities for dragontree_reolink."""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB, DOMAIN

_DEVICE_INFO = DeviceInfo(
    identifiers={(DOMAIN, "dragontree_reolink")},
    name="Dragontree Reolink",
    manufacturer="Dragontree",
    model="Reolink Downloader",
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up number entities."""
    async_add_entities([MaxDiskGbNumber(entry)])


class MaxDiskGbNumber(NumberEntity):
    """Configurable max disk space for local recordings."""

    _attr_has_entity_name = True
    _attr_name = "Max Disk Space"
    _attr_icon = "mdi:harddisk"
    _attr_native_min_value = 1
    _attr_native_max_value = 500
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "GB"
    _attr_mode = NumberMode.BOX
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_max_disk_gb"

    @property
    def device_info(self) -> DeviceInfo:
        return _DEVICE_INFO

    @property
    def native_value(self) -> int:
        return self._entry.options.get(CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB)

    async def async_set_native_value(self, value: float) -> None:
        new_options = {**self._entry.options, CONF_MAX_DISK_GB: int(value)}
        self.hass.config_entries.async_update_entry(self._entry, options=new_options)
