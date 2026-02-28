"""Sensors for dragontree_reolink."""

from __future__ import annotations

import logging

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_MAX_DISK_GB,
    DEFAULT_MAX_DISK_GB,
    DOMAIN,
    SIGNAL_UPDATE,
)
from .coordinator import ReolinkDownloadCoordinator

_LOGGER = logging.getLogger(__name__)

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
    """Set up sensors."""
    coordinator: ReolinkDownloadCoordinator = entry.runtime_data
    async_add_entities(
        [
            DiskUsedSensor(coordinator, entry),
            QueueSizeSensor(coordinator, entry),
            TotalRecordingsSensor(coordinator, entry),
            LastDownloadSensor(coordinator, entry),
        ]
    )


class _ReolinkSensorBase(SensorEntity):
    """Base class for dragontree_reolink sensors."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self, coordinator: ReolinkDownloadCoordinator, entry: ConfigEntry
    ) -> None:
        self._coordinator = coordinator
        self._entry = entry

    @property
    def device_info(self) -> DeviceInfo:
        return _DEVICE_INFO

    async def async_added_to_hass(self) -> None:
        """Subscribe to coordinator update signals."""
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_UPDATE, self._handle_update
            )
        )

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()


class DiskUsedSensor(_ReolinkSensorBase):
    """Sensor: gigabytes of local storage used."""

    _attr_name = "Disk Used"
    _attr_icon = "mdi:harddisk"
    _attr_native_unit_of_measurement = "GB"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_disk_used"

    @property
    def native_value(self) -> float:
        return round(self._coordinator.disk_used_bytes / 1024**3, 2)

    @property
    def extra_state_attributes(self) -> dict:
        max_gb = self._entry.options.get(CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB)
        used_bytes = self._coordinator.disk_used_bytes
        used_gb = used_bytes / 1024**3
        return {
            "max_disk_gb": max_gb,
            "used_percent": round(used_gb / max_gb * 100, 1) if max_gb else 0,
            "free_gb": round(max_gb - used_gb, 2),
        }


class QueueSizeSensor(_ReolinkSensorBase):
    """Sensor: number of recordings currently queued for download."""

    _attr_name = "Download Queue"
    _attr_icon = "mdi:download-circle"
    _attr_native_unit_of_measurement = "recordings"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_queue_size"

    @property
    def native_value(self) -> int:
        return self._coordinator.queue_size


class TotalRecordingsSensor(_ReolinkSensorBase):
    """Sensor: total number of locally stored recordings."""

    _attr_name = "Total Recordings"
    _attr_icon = "mdi:video-multiple"
    _attr_native_unit_of_measurement = "recordings"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_total_recordings"

    @property
    def native_value(self) -> int:
        return self._coordinator.total_recordings


class LastDownloadSensor(_ReolinkSensorBase):
    """Sensor: timestamp of the most recent completed download."""

    _attr_name = "Last Download"
    _attr_icon = "mdi:clock-check"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, coordinator: ReolinkDownloadCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.entry_id}_last_download"

    @property
    def native_value(self):
        return self._coordinator.last_download
