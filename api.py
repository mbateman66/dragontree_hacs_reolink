"""WebSocket API commands for dragontree_reolink."""

from __future__ import annotations

from typing import TYPE_CHECKING

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import callback

from .const import DOMAIN, LOGGER, MEDIA_BASE_DIR

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .data import DragontreeReolinkData

# /media/ is two levels above MEDIA_BASE_DIR: /media/Dragontree/Reolink → /media/
_MEDIA_ROOT = "/media/"


def _path_to_content_id(path: str) -> str:
    """Convert an absolute local path to a media_source content_id.

    Example:
      /media/Dragontree/Reolink/Driveway Camera/main/2026/02/27/file.mp4
      → media-source://media_source/local/Dragontree/Reolink/Driveway Camera/main/2026/02/27/file.mp4
    """
    rel = path.removeprefix(_MEDIA_ROOT)
    return f"media-source://media_source/local/{rel}"


@callback
def async_register_ws_commands(hass: HomeAssistant) -> None:
    """Register WebSocket API commands (idempotent)."""
    websocket_api.async_register_command(hass, ws_get_recordings)
    websocket_api.async_register_command(hass, ws_get_pending)
    websocket_api.async_register_command(hass, ws_get_cameras)
    websocket_api.async_register_command(hass, ws_get_cameras_config)
    websocket_api.async_register_command(hass, ws_set_camera_in_schedule)
    websocket_api.async_register_command(hass, ws_get_schedule)
    websocket_api.async_register_command(hass, ws_set_schedule)
    websocket_api.async_register_command(hass, ws_get_record_timers)
    websocket_api.async_register_command(hass, ws_get_timer_config)
    websocket_api.async_register_command(hass, ws_set_timer_config)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_recordings",
        vol.Optional("cameras"): [str],
        vol.Optional("triggers"): [str],
        vol.Optional("start_dt"): str,
        vol.Optional("end_dt"): str,
        vol.Optional("before_dt"): str,
        vol.Optional("after_dt"): str,
        vol.Optional("sort_desc", default=True): bool,
        vol.Optional("limit"): int,
    }
)
@websocket_api.async_response
async def ws_get_recordings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return recordings matching the given filters."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    cameras = msg.get("cameras") or None
    triggers = msg.get("triggers") or None

    rows = await runtime_data.coordinator._db.query(
        cameras=cameras,
        triggers=triggers,
        start_dt=msg.get("start_dt"),
        end_dt=msg.get("end_dt"),
        before_dt=msg.get("before_dt"),
        after_dt=msg.get("after_dt"),
        sort_desc=msg.get("sort_desc", True),
        limit=msg.get("limit"),
    )

    # Attach media_source content_ids for URL resolution on the frontend
    for row in rows:
        row["content_id"] = _path_to_content_id(row["path"])
        if row.get("thumb_path"):
            row["thumb_content_id"] = _path_to_content_id(row["thumb_path"])

    pending = runtime_data.coordinator.get_pending_recordings()

    connection.send_result(msg["id"], {"recordings": rows, "pending": pending})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_pending"})
@websocket_api.async_response
async def ws_get_pending(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return only pending (recording/queued/downloading) items. No DB query."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return
    connection.send_result(msg["id"], {"pending": runtime_data.coordinator.get_pending_recordings()})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_cameras"}
)
@websocket_api.async_response
async def ws_get_cameras(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return all distinct camera names known to the database."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    cameras = await runtime_data.coordinator._db.get_distinct_cameras()
    connection.send_result(msg["id"], {"cameras": cameras})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_cameras_config"}
)
@websocket_api.async_response
async def ws_get_cameras_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return per-camera config: name, pir_entity_id, in_schedule, enabled."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    cameras = await runtime_data.coordinator.async_get_cameras_config()
    connection.send_result(msg["id"], {"cameras": cameras})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_camera_in_schedule",
        vol.Required("camera"): str,
        vol.Required("in_schedule"): bool,
    }
)
@websocket_api.async_response
async def ws_set_camera_in_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Update whether a camera is included in the automated schedule."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    await runtime_data.coordinator.async_set_camera_in_schedule(
        msg["camera"], msg["in_schedule"]
    )
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_schedule"}
)
@websocket_api.async_response
async def ws_get_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the current camera schedule settings."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    schedule = runtime_data.coordinator.async_get_schedule()
    connection.send_result(msg["id"], schedule)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_record_timers"}
)
@websocket_api.async_response
async def ws_get_record_timers(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return active manual recording timers for all cameras."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    timers = runtime_data.coordinator.get_record_timers()
    connection.send_result(msg["id"], {"timers": timers})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_schedule",
        vol.Required("enabled"): bool,
        vol.Required("start_time"): str,
        vol.Required("stop_time"): str,
    }
)
@websocket_api.async_response
async def ws_set_schedule(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Update camera schedule settings."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    await runtime_data.coordinator.async_set_schedule(
        msg["enabled"], msg["start_time"], msg["stop_time"]
    )
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/get_timer_config"}
)
@websocket_api.async_response
async def ws_get_timer_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the current live-view and recording timeout settings."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    connection.send_result(msg["id"], runtime_data.coordinator.async_get_timer_config())


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/set_timer_config",
        vol.Required("live_timeout_secs"): vol.All(int, vol.Range(min=15, max=600)),
        vol.Required("record_timeout_secs"): vol.All(int, vol.Range(min=15, max=600)),
    }
)
@websocket_api.async_response
async def ws_set_timer_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Update live-view and recording timeout settings."""
    runtime_data: DragontreeReolinkData | None = hass.data.get(DOMAIN)
    if runtime_data is None:
        connection.send_error(msg["id"], "not_ready", "Coordinator not available")
        return

    await runtime_data.coordinator.async_set_timer_config(
        msg["live_timeout_secs"], msg["record_timeout_secs"]
    )
    connection.send_result(msg["id"], {})
