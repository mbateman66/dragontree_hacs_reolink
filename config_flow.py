"""Config flow for dragontree_reolink."""

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_MAX_DISK_GB,
    CONF_STREAM,
    DEFAULT_MAX_DISK_GB,
    DEFAULT_STREAM,
    DOMAIN,
    REOLINK_DOMAIN,
)

STREAM_OPTIONS = {
    "main": "High resolution (main stream)",
    "sub": "Low resolution (sub stream)",
}


class DragontreeReolinkConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Dragontree Reolink."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Handle the initial step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if not self.hass.config_entries.async_loaded_entries(REOLINK_DOMAIN):
            return self.async_abort(reason="no_reolink")

        if user_input is not None:
            return self.async_create_entry(
                title="Dragontree Reolink",
                data={},
                options={
                    CONF_MAX_DISK_GB: user_input[CONF_MAX_DISK_GB],
                    CONF_STREAM: user_input[CONF_STREAM],
                },
            )

        schema = vol.Schema(
            {
                vol.Required(CONF_MAX_DISK_GB, default=DEFAULT_MAX_DISK_GB): vol.All(
                    vol.Coerce(int), vol.Range(min=1, max=500)
                ),
                vol.Required(CONF_STREAM, default=DEFAULT_STREAM): vol.In(
                    STREAM_OPTIONS
                ),
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> DragontreeReolinkOptionsFlow:
        """Return the options flow."""
        return DragontreeReolinkOptionsFlow(config_entry)


class DragontreeReolinkOptionsFlow(config_entries.OptionsFlow):
    """Handle options updates."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict | None = None) -> FlowResult:
        """Handle options step."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_MAX_DISK_GB,
                    default=current.get(CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB),
                ): vol.All(vol.Coerce(int), vol.Range(min=1, max=500)),
                vol.Required(
                    CONF_STREAM,
                    default=current.get(CONF_STREAM, DEFAULT_STREAM),
                ): vol.In(STREAM_OPTIONS),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema)
