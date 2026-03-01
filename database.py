"""SQLite metadata store for dragontree_reolink recordings."""

from __future__ import annotations

import aiosqlite

from .const import LOGGER

_SCHEMA = """
CREATE TABLE IF NOT EXISTS recordings (
    path          TEXT PRIMARY KEY,
    camera        TEXT NOT NULL,
    channel       INTEGER NOT NULL,
    stream        TEXT NOT NULL,
    start_time    TEXT,
    end_time      TEXT,
    duration_s    REAL,
    triggers      TEXT,
    file_size     INTEGER,
    downloaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_camera     ON recordings (camera);
CREATE INDEX IF NOT EXISTS idx_start_time ON recordings (start_time);
CREATE INDEX IF NOT EXISTS idx_triggers   ON recordings (triggers);

CREATE TABLE IF NOT EXISTS last_check (
    key        TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL
);
"""


class RecordingsDB:
    """Async SQLite wrapper for recording metadata and poll state."""

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    async def async_init(self) -> None:
        """Open the database and ensure the schema exists."""
        self._conn = await aiosqlite.connect(self._db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(_SCHEMA)
        await self._conn.commit()
        # Schema migrations — add columns introduced after initial release
        for col in ("image_path", "thumb_path"):
            try:
                await self._conn.execute(
                    f"ALTER TABLE recordings ADD COLUMN {col} TEXT"
                )
                await self._conn.commit()
                LOGGER.info("Migrated DB: added column %s", col)
            except Exception:
                pass  # Column already exists
        LOGGER.info("Recordings database ready: %s", self._db_path)

    async def async_close(self) -> None:
        """Close the database connection."""
        if self._conn:
            await self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------ #
    # Recordings                                                           #
    # ------------------------------------------------------------------ #

    async def upsert(self, record: dict) -> None:
        """Insert or update a single recording record."""
        await self._conn.execute(
            """
            INSERT OR REPLACE INTO recordings
                (path, camera, channel, stream, start_time, end_time,
                 duration_s, triggers, file_size, downloaded_at,
                 image_path, thumb_path)
            VALUES
                (:path, :camera, :channel, :stream, :start_time, :end_time,
                 :duration_s, :triggers, :file_size, :downloaded_at,
                 :image_path, :thumb_path)
            """,
            record,
        )
        await self._conn.commit()

    async def upsert_many(self, records: list[dict]) -> None:
        """Bulk insert or update recording records."""
        await self._conn.executemany(
            """
            INSERT OR REPLACE INTO recordings
                (path, camera, channel, stream, start_time, end_time,
                 duration_s, triggers, file_size, downloaded_at,
                 image_path, thumb_path)
            VALUES
                (:path, :camera, :channel, :stream, :start_time, :end_time,
                 :duration_s, :triggers, :file_size, :downloaded_at,
                 :image_path, :thumb_path)
            """,
            records,
        )
        await self._conn.commit()

    async def delete(self, path: str) -> None:
        """Remove a recording record by file path."""
        await self._conn.execute("DELETE FROM recordings WHERE path = ?", (path,))
        await self._conn.commit()

    async def get_files(self) -> list[dict]:
        """Return all recordings ordered oldest-first (for disk management)."""
        async with self._conn.execute(
            "SELECT path, camera, file_size, downloaded_at FROM recordings ORDER BY downloaded_at"
        ) as cur:
            rows = await cur.fetchall()
            return [dict(row) for row in rows]

    # ------------------------------------------------------------------ #
    # Poll state                                                           #
    # ------------------------------------------------------------------ #

    async def upsert_last_check(self, key: str, checked_at: str) -> None:
        """Record the last poll time for a channel key."""
        await self._conn.execute(
            "INSERT OR REPLACE INTO last_check (key, checked_at) VALUES (?, ?)",
            (key, checked_at),
        )
        await self._conn.commit()

    async def get_last_check(self) -> dict[str, str]:
        """Return all last-check entries as {key: iso_string}."""
        async with self._conn.execute("SELECT key, checked_at FROM last_check") as cur:
            rows = await cur.fetchall()
            return {row["key"]: row["checked_at"] for row in rows}

    # ------------------------------------------------------------------ #
    # Playback queries                                                     #
    # ------------------------------------------------------------------ #

    async def query(
        self,
        cameras: list[str] | None = None,
        triggers: list[str] | None = None,
        start_dt: str | None = None,
        end_dt: str | None = None,
        sort_desc: bool = True,
    ) -> list[dict]:
        """Return recordings matching the given filters."""
        clauses: list[str] = []
        params: list = []

        if cameras:
            placeholders = ",".join("?" * len(cameras))
            clauses.append(f"camera IN ({placeholders})")
            params.extend(cameras)

        if start_dt:
            clauses.append("start_time >= ?")
            params.append(start_dt)

        if end_dt:
            clauses.append("start_time <= ?")
            params.append(end_dt)

        if triggers:
            # Match recordings that contain at least one of the requested triggers.
            # Triggers are stored as a JSON array e.g. '["ANIMAL","VEHICLE"]'.
            trigger_clauses = [f'triggers LIKE ?' for _ in triggers]
            clauses.append(f"({' OR '.join(trigger_clauses)})")
            params.extend([f'%"{t}"%' for t in triggers])

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        order = "DESC" if sort_desc else "ASC"

        sql = f"""
            SELECT path, camera, channel, stream, start_time, end_time,
                   duration_s, triggers, file_size, downloaded_at,
                   image_path, thumb_path
            FROM recordings
            {where}
            ORDER BY COALESCE(start_time, downloaded_at) {order}
        """

        async with self._conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
            return [dict(row) for row in rows]

    async def get_files_without_thumbnails(self) -> list[dict]:
        """Return recordings that have no thumbnail yet, oldest first."""
        async with self._conn.execute(
            "SELECT path FROM recordings WHERE thumb_path IS NULL ORDER BY downloaded_at"
        ) as cur:
            rows = await cur.fetchall()
            return [dict(row) for row in rows]

    async def update_image_paths(
        self, path: str, image_path: str | None, thumb_path: str | None
    ) -> None:
        """Set the image/thumb paths for an existing recording."""
        await self._conn.execute(
            "UPDATE recordings SET image_path = ?, thumb_path = ? WHERE path = ?",
            (image_path, thumb_path, path),
        )
        await self._conn.commit()

    async def get_distinct_cameras(self) -> list[str]:
        """Return all distinct camera names, ordered alphabetically."""
        async with self._conn.execute(
            "SELECT DISTINCT camera FROM recordings ORDER BY camera"
        ) as cur:
            rows = await cur.fetchall()
            return [row["camera"] for row in rows]
