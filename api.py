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
    websocket_api.async_register_command(hass, ws_get_cameras)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get_recordings",
        vol.Optional("cameras"): [str],
        vol.Optional("triggers"): [str],
        vol.Optional("start_dt"): str,
        vol.Optional("end_dt"): str,
        vol.Optional("sort_desc", default=True): bool,
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
        sort_desc=msg.get("sort_desc", True),
    )

    # Attach media_source content_ids for URL resolution on the frontend
    for row in rows:
        row["content_id"] = _path_to_content_id(row["path"])
        if row.get("thumb_path"):
            row["thumb_content_id"] = _path_to_content_id(row["thumb_path"])

    connection.send_result(msg["id"], {"recordings": rows})


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
