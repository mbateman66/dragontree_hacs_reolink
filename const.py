"""Constants for dragontree_reolink."""

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
POLL_INTERVAL = 60

# Extra lookback on each poll to catch recordings the camera finished writing
# after the previous poll window closed (seconds)
POLL_LOOKBACK_BUFFER = 600

# Delay after motion ends before checking for new recordings (seconds).
# Accounts for Reolink's post-motion recording extension (up to 30 s) plus
# time for the hub to finalize the file.
MOTION_END_DELAY = 45

# Fallback delay after motion starts, in case the motion-end event never arrives.
MOTION_START_FALLBACK_DELAY = 120

# Recordings to download per camera at startup
INIT_RECORDINGS_PER_CAMERA = 2

# How many days back to look for the initial recordings
INIT_LOOKBACK_DAYS = 30

# Dispatcher signal for sensor updates
SIGNAL_UPDATE = f"{DOMAIN}_update"
