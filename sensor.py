"""Sensors for dragontree_reolink."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)

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
    """Set up sensors."""
    coordinator = entry.runtime_data.coordinator
    async_add_entities(
        [
            DiskUsedSensor(coordinator),
            QueueSizeSensor(coordinator),
            TotalRecordingsSensor(coordinator),
            LastDownloadSensor(coordinator),
        ]
    )


class _ReolinkSensorBase(DragontreeReolinkEntity, SensorEntity):
    """Base class for dragontree_reolink sensors."""


class DiskUsedSensor(_ReolinkSensorBase):
    """Sensor: gigabytes of local storage used."""

    _attr_icon = "mdi:harddisk"
    _attr_native_unit_of_measurement = "GB"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_disk_used"
        self._attr_name = "Disk Used"

    @property
    def native_value(self) -> float:
        return round(self._coordinator.disk_used_bytes / 1024**3, 2)

    @property
    def extra_state_attributes(self) -> dict:
        max_gb = self._coordinator.config_entry.options.get(
            CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB
        )
        used_gb = self._coordinator.disk_used_bytes / 1024**3
        return {
            "max_disk_gb": max_gb,
            "used_percent": round(used_gb / max_gb * 100, 1) if max_gb else 0,
            "free_gb": round(max_gb - used_gb, 2),
        }


class QueueSizeSensor(_ReolinkSensorBase):
    """Sensor: number of recordings currently queued for download."""

    _attr_icon = "mdi:download-circle"
    _attr_native_unit_of_measurement = "recordings"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_queue_size"
        self._attr_name = "Download Queue"

    @property
    def native_value(self) -> int:
        return self._coordinator.queue_size


class TotalRecordingsSensor(_ReolinkSensorBase):
    """Sensor: total number of locally stored recordings."""

    _attr_icon = "mdi:video-multiple"
    _attr_native_unit_of_measurement = "recordings"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_total_recordings"
        self._attr_name = "Total Recordings"

    @property
    def native_value(self) -> int:
        return self._coordinator.total_recordings


class LastDownloadSensor(_ReolinkSensorBase):
    """Sensor: timestamp of the most recent completed download."""

    _attr_icon = "mdi:clock-check"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, coordinator: ReolinkDownloadCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}_last_download"
        self._attr_name = "Last Download"

    @property
    def native_value(self):
        return self._coordinator.last_download
