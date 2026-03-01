"""Config flow for dragontree_reolink."""

from __future__ import annotations

from typing import TYPE_CHECKING

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_MAX_DISK_GB,
    CONF_STREAM,
    DEFAULT_MAX_DISK_GB,
    DEFAULT_STREAM,
    DOMAIN,
    REOLINK_DOMAIN,
)

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigFlowResult


def _build_schema(
    max_disk_gb: int = DEFAULT_MAX_DISK_GB,
    stream: str = DEFAULT_STREAM,
) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_MAX_DISK_GB, default=max_disk_gb): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=1,
                    max=500,
                    step=1,
                    unit_of_measurement="GB",
                    mode=selector.NumberSelectorMode.BOX,
                )
            ),
            vol.Required(CONF_STREAM, default=stream): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=[
                        selector.SelectOptionDict(
                            value="main", label="High resolution (main stream)"
                        ),
                        selector.SelectOptionDict(
                            value="sub", label="Low resolution (sub stream)"
                        ),
                    ],
                    mode=selector.SelectSelectorMode.LIST,
                )
            ),
        }
    )


class DragontreeReolinkConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Dragontree Reolink."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict | None = None
    ) -> ConfigFlowResult:
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
                    CONF_MAX_DISK_GB: int(user_input[CONF_MAX_DISK_GB]),
                    CONF_STREAM: user_input[CONF_STREAM],
                },
            )

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(),
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,  # noqa: ARG004
    ) -> DragontreeReolinkOptionsFlow:
        """Return the options flow."""
        return DragontreeReolinkOptionsFlow()


class DragontreeReolinkOptionsFlow(config_entries.OptionsFlow):
    """Handle options updates."""

    async def async_step_init(
        self, user_input: dict | None = None
    ) -> ConfigFlowResult:
        """Handle options step."""
        if user_input is not None:
            return self.async_create_entry(
                data={
                    CONF_MAX_DISK_GB: int(user_input[CONF_MAX_DISK_GB]),
                    CONF_STREAM: user_input[CONF_STREAM],
                }
            )

        current = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=_build_schema(
                max_disk_gb=current.get(CONF_MAX_DISK_GB, DEFAULT_MAX_DISK_GB),
                stream=current.get(CONF_STREAM, DEFAULT_STREAM),
            ),
        )
