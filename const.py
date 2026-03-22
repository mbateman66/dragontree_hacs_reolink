"""Constants for dragontree_reolink."""

from logging import Logger, getLogger

LOGGER: Logger = getLogger(__package__)

DOMAIN = "dragontree_reolink"
REOLINK_DOMAIN = "reolink"

CONF_MAX_DISK_GB = "max_disk_gb"
CONF_STREAM = "stream"

DEFAULT_MAX_DISK_GB = 5
DEFAULT_STREAM = "main"

# Local media path: /media/Dragontree/Reolink/<camera>/<stream>/<year>/<mm>/<dd>/<file>
MEDIA_BASE_DIR = "/media/Dragontree/Reolink"
DB_PATH = "/config/.storage/dragontree_reolink_recordings.db"

# How often to poll for new recordings (seconds)
POLL_INTERVAL = 15

# Extra lookback on each poll to catch recordings the camera finished writing
# after the previous poll window closed (seconds)
POLL_LOOKBACK_BUFFER = 600

# Minimum age of a recording's end_time before we attempt to download it.
# The hub updates end_time continuously while recording (to roughly "now"),
# so end_time alone does not tell us the recording is complete.  We wait this
# many seconds after end_time to be sure the file has been finalized.
MIN_RECORDING_AGE_S = 30

# Recordings to download per camera at startup
INIT_RECORDINGS_PER_CAMERA = 2

# How many days back to look for the initial recordings
INIT_LOOKBACK_DAYS = 30

# Dispatcher signal for sensor updates
SIGNAL_UPDATE = f"{DOMAIN}_update"

# HA event bus event fired when a recording is fully downloaded and saved to DB.
# Subscribed to by the Lovelace card for live list updates.
EVENT_RECORDING_ADDED = f"{DOMAIN}_recording_added"

# HA event bus event fired when the pending queue changes (item queued or status
# changes to downloading).  Subscribed to by the Lovelace card to show pending rows.
EVENT_QUEUE_CHANGED = f"{DOMAIN}_queue_changed"

# HA event bus event fired when a manual recording timer starts or stops.
# Payload: {"camera": str, "action": "started"|"stopped",
#           "started_at": isoformat str, "timeout_secs": int}  (started only)
EVENT_RECORD_TIMER_CHANGED = f"{DOMAIN}_record_timer_changed"

# Server-side timeout for manual recordings (seconds).
MANUAL_REC_TIMEOUT_SECS = 120
