import sqlite3
import os
import config


def get_db():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'record',
        status TEXT NOT NULL DEFAULT 'queued',
        title TEXT,
        url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        scheduled_at TEXT,
        priority INTEGER DEFAULT 0,
        progress INTEGER DEFAULT 0,
        error TEXT,
        folder TEXT,
        output_file TEXT,
        thumbnail TEXT,
        metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    """)
    conn.commit()
    # Add columns if upgrading from old schema (before creating indexes on them)
    for col, coldef in [("scheduled_at", "TEXT"), ("priority", "INTEGER DEFAULT 0")]:
        try:
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {coldef}")
            conn.commit()
        except Exception:
            pass
    # Now safe to create indexes on new columns
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at)")
    conn.commit()
    conn.close()
