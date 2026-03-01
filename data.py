"""Custom types for dragontree_reolink."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

    from .coordinator import ReolinkDownloadCoordinator


type DragontreeReolinkConfigEntry = ConfigEntry["DragontreeReolinkData"]


@dataclass
class DragontreeReolinkData:
    """Runtime data stored on the config entry."""

    coordinator: ReolinkDownloadCoordinator
