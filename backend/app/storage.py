from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "velox.sqlite3"

_lock = threading.Lock()
_connection: sqlite3.Connection | None = None


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _create_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL;")
    connection.execute("PRAGMA synchronous=NORMAL;")
    connection.execute("PRAGMA foreign_keys=ON;")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS tab_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id TEXT NOT NULL,
            browser_tab_id TEXT NOT NULL,
            active_tab_id TEXT,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            is_start_page INTEGER NOT NULL DEFAULT 0,
            captured_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tab_snapshots_captured_at
            ON tab_snapshots(captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tab_snapshots_tab_id
            ON tab_snapshots(browser_tab_id, captured_at DESC);

        CREATE TABLE IF NOT EXISTS organize_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy TEXT NOT NULL,
            active_tab_id TEXT,
            request_json TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_organize_runs_created_at
            ON organize_runs(created_at DESC);

        CREATE TABLE IF NOT EXISTS hibernated_tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            browser_tab_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            reason TEXT NOT NULL,
            origin_batch_id TEXT,
            restored_at TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_hibernated_tabs_created_at
            ON hibernated_tabs(created_at DESC);

        CREATE TABLE IF NOT EXISTS closed_tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            browser_tab_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            text TEXT NOT NULL,
            reason TEXT NOT NULL,
            restored_at TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_closed_tabs_created_at
            ON closed_tabs(created_at DESC);
        """
    )
    return connection


def get_connection() -> sqlite3.Connection:
    global _connection
    with _lock:
        if _connection is None:
            _connection = _create_connection()
        return _connection


def save_tab_snapshot(
    tabs: list[dict[str, Any]],
    active_tab_id: str | None,
) -> dict[str, Any]:
    batch_id = str(uuid.uuid4())
    captured_at = now_iso()
    rows = [
        (
            batch_id,
            tab.get("id", ""),
            active_tab_id,
            tab.get("url", ""),
            tab.get("title", ""),
            tab.get("text", ""),
            1 if tab.get("is_start_page") else 0,
            captured_at,
        )
        for tab in tabs
    ]

    connection = get_connection()
    with _lock:
        connection.executemany(
            """
            INSERT INTO tab_snapshots (
                batch_id, browser_tab_id, active_tab_id, url, title, text, is_start_page, captured_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        connection.commit()

    return {"batch_id": batch_id, "captured_at": captured_at, "tab_count": len(rows)}


def save_organize_run(
    strategy: str,
    active_tab_id: str | None,
    request_payload: dict[str, Any],
    response_payload: dict[str, Any],
) -> dict[str, Any]:
    created_at = now_iso()
    connection = get_connection()
    with _lock:
        cursor = connection.execute(
            """
            INSERT INTO organize_runs (
                strategy, active_tab_id, request_json, response_json, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                strategy,
                active_tab_id,
                json.dumps(request_payload, ensure_ascii=False),
                json.dumps(response_payload, ensure_ascii=False),
                created_at,
            ),
        )
        connection.commit()

    return {"id": cursor.lastrowid, "created_at": created_at}


def save_hibernated_tab(
    tab: dict[str, Any],
    reason: str,
    origin_batch_id: str | None = None,
) -> dict[str, Any]:
    created_at = now_iso()
    connection = get_connection()
    with _lock:
        cursor = connection.execute(
            """
            INSERT INTO hibernated_tabs (
                browser_tab_id, url, title, text, reason, origin_batch_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tab.get("id", ""),
                tab.get("url", ""),
                tab.get("title", ""),
                tab.get("text", ""),
                reason,
                origin_batch_id,
                created_at,
            ),
        )
        connection.commit()

    return {"id": cursor.lastrowid, "created_at": created_at}


def list_hibernated_tabs(limit: int = 20) -> list[dict[str, Any]]:
    connection = get_connection()
    with _lock:
        rows = connection.execute(
            """
            SELECT id, browser_tab_id, url, title, text, reason, origin_batch_id, restored_at, created_at
            FROM hibernated_tabs
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def save_closed_tab(
    tab: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    created_at = now_iso()
    connection = get_connection()
    with _lock:
        cursor = connection.execute(
            """
            INSERT INTO closed_tabs (
                browser_tab_id, url, title, text, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                tab.get("id", ""),
                tab.get("url", ""),
                tab.get("title", ""),
                tab.get("text", ""),
                reason,
                created_at,
            ),
        )
        connection.commit()

    return {"id": cursor.lastrowid, "created_at": created_at}


def list_closed_tabs(limit: int = 20) -> list[dict[str, Any]]:
    connection = get_connection()
    with _lock:
        rows = connection.execute(
            """
            SELECT id, browser_tab_id, url, title, text, reason, restored_at, created_at
            FROM closed_tabs
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def restore_closed_tab(record_id: int) -> dict[str, Any] | None:
    restored_at = now_iso()
    connection = get_connection()
    with _lock:
        row = connection.execute(
            """
            SELECT id, browser_tab_id, url, title, text, reason, restored_at, created_at
            FROM closed_tabs
            WHERE id = ?
            """,
            (record_id,),
        ).fetchone()
        if row is None:
            return None
        connection.execute(
            """
            UPDATE closed_tabs
            SET restored_at = ?
            WHERE id = ? AND restored_at IS NULL
            """,
            (restored_at, record_id),
        )
        connection.commit()
    payload = dict(row)
    payload["restored_at"] = restored_at
    return payload


def restore_hibernated_tab(record_id: int) -> dict[str, Any] | None:
    restored_at = now_iso()
    connection = get_connection()
    with _lock:
        row = connection.execute(
            """
            SELECT id, browser_tab_id, url, title, text, reason, origin_batch_id, restored_at, created_at
            FROM hibernated_tabs
            WHERE id = ?
            """,
            (record_id,),
        ).fetchone()
        if row is None:
            return None
        connection.execute(
            """
            UPDATE hibernated_tabs
            SET restored_at = ?
            WHERE id = ? AND restored_at IS NULL
            """,
            (restored_at, record_id),
        )
        connection.commit()
    payload = dict(row)
    payload["restored_at"] = restored_at
    return payload


def list_summary() -> dict[str, Any]:
    connection = get_connection()
    with _lock:
        snapshot_count = connection.execute("SELECT COUNT(*) AS value FROM tab_snapshots").fetchone()["value"]
        organize_count = connection.execute("SELECT COUNT(*) AS value FROM organize_runs").fetchone()["value"]
        hibernated_count = connection.execute("SELECT COUNT(*) AS value FROM hibernated_tabs").fetchone()["value"]
        closed_count = connection.execute("SELECT COUNT(*) AS value FROM closed_tabs").fetchone()["value"]
        latest_snapshot = connection.execute(
            "SELECT captured_at FROM tab_snapshots ORDER BY captured_at DESC LIMIT 1"
        ).fetchone()
        latest_organize = connection.execute(
            "SELECT strategy, created_at, response_json FROM organize_runs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        latest_closed = connection.execute(
            "SELECT created_at FROM closed_tabs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()

    latest_organize_payload = None
    if latest_organize:
        response_json = latest_organize["response_json"]
        try:
            latest_organize_payload = json.loads(response_json)
        except json.JSONDecodeError:
            latest_organize_payload = None

    return {
        "snapshot_count": snapshot_count,
        "organize_count": organize_count,
        "hibernated_count": hibernated_count,
        "closed_count": closed_count,
        "latest_snapshot_at": latest_snapshot["captured_at"] if latest_snapshot else None,
        "latest_closed_at": latest_closed["created_at"] if latest_closed else None,
        "latest_organize": {
            "strategy": latest_organize["strategy"],
            "created_at": latest_organize["created_at"],
            "group_count": len(latest_organize_payload.get("groups", [])) if latest_organize_payload else 0,
            "duplicate_set_count": len(latest_organize_payload.get("duplicate_sets", [])) if latest_organize_payload else 0,
        } if latest_organize else None,
    }
