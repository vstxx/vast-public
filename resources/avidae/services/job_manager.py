import os
import json
import uuid
import queue
import threading
import sqlite3
from datetime import datetime, timezone

import config
import database
from services.storage import ensure_job_folder, delete_job_folder, get_job_folder
from services.logger import get_job_logger, close_job_logger, append_log_event

_active_jobs = {}
_job_lock = threading.Lock()
_cancel_flags = {}
_job_queue = queue.PriorityQueue()
_socketio = None  # Set by app.py


def _public_job(job):
    if not job:
        return None
    clean = dict(job)
    clean.pop("folder", None)
    clean.pop("params", None)
    return clean


def set_socketio(sio):
    global _socketio
    _socketio = sio


def emit_job_update(job_id, data=None):
    """Emit real-time job update via SocketIO."""
    if _socketio:
        if data is None:
            data = get_job(job_id)
        if data:
            try:
                _socketio.emit("job_update", _public_job(data))
            except Exception:
                pass


def create_job(job_type, params):
    job_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()

    job_folder = ensure_job_folder(job_id)

    title = params.get("title") or f"{job_type.title()} — {params.get('url', 'file')}"
    url = params.get("url", "")
    priority = int(params.get("priority", 0))
    scheduled_at = params.get("scheduled_at")

    job = {
        "id": job_id,
        "type": job_type,
        "status": "queued",
        "title": title[:120],
        "url": url,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "completed_at": None,
        "scheduled_at": scheduled_at,
        "priority": priority,
        "progress": 0,
        "error": None,
        "folder": job_folder,
        "output_file": None,
        "thumbnail": None,
        "params": params,
    }

    _save_metadata(job_id, job)

    conn = database.get_db()
    try:
        conn.execute(
            """INSERT INTO jobs (id, type, status, title, url, created_at, updated_at,
               folder, metadata, priority, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (job_id, job_type, "queued", job["title"], url, now, now,
             job_folder, json.dumps(params), priority, scheduled_at)
        )
        conn.commit()
    finally:
        conn.close()

    logger = get_job_logger(job_id, job_folder)
    logger.info(f"Job created: {job_id} ({job_type})")
    if scheduled_at:
        logger.info(f"Scheduled for: {scheduled_at}")
    if priority:
        logger.info(f"Priority: {priority}")
    append_log_event(job_folder, "created", f"Job {job_id} created", {"type": job_type})

    emit_job_update(job_id, job)
    return job


def start_job(job_id, runner_func):
    with _job_lock:
        active = sum(1 for s in _active_jobs.values() if s in ("analyzing", "recording", "post-processing"))
        if active >= config.MAX_CONCURRENT_JOBS:
            return False, "Max concurrent jobs reached"

        _cancel_flags[job_id] = threading.Event()
        t = threading.Thread(target=_run_job, args=(job_id, runner_func), daemon=True)
        _active_jobs[job_id] = "running"
        t.start()
        return True, "started"


def _run_job(job_id, runner_func):
    try:
        runner_func(job_id, _cancel_flags.get(job_id))
    except Exception as e:
        update_job(job_id, status="failed", error=str(e))
        job_folder = get_job_folder(job_id)
        logger = get_job_logger(job_id, job_folder)
        logger.error(f"Job failed with exception: {e}")
    finally:
        with _job_lock:
            _active_jobs.pop(job_id, None)
            _cancel_flags.pop(job_id, None)
        close_job_logger(job_id)
        emit_job_update(job_id)


def update_job(job_id, **kwargs):
    now = datetime.now(timezone.utc).isoformat()
    kwargs["updated_at"] = now

    meta = _load_metadata(job_id)
    if meta:
        meta.update(kwargs)
        _save_metadata(job_id, meta)

    conn = database.get_db()
    try:
        sets = []
        vals = []
        for k, v in kwargs.items():
            if k in ("status", "title", "progress", "error", "output_file",
                     "thumbnail", "started_at", "completed_at", "updated_at",
                     "priority", "scheduled_at"):
                sets.append(f"{k} = ?")
                vals.append(v)
        if sets:
            vals.append(job_id)
            conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", vals)
            conn.commit()
    finally:
        conn.close()

    emit_job_update(job_id)


def cancel_job(job_id):
    flag = _cancel_flags.get(job_id)
    if flag:
        flag.set()
        update_job(job_id, status="cancelled")
        return True
    meta = _load_metadata(job_id)
    if meta and meta.get("status") in ("queued",):
        update_job(job_id, status="cancelled")
        return True
    return False


def delete_job(job_id):
    cancel_job(job_id)
    conn = database.get_db()
    try:
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.commit()
    finally:
        conn.close()
    delete_job_folder(job_id)
    return True


def retry_job(job_id, runner_map):
    """Clone a failed/cancelled job's params into a new job and start it."""
    old = get_job(job_id)
    if not old:
        return None, "Job not found"
    if old.get("status") not in ("failed", "cancelled"):
        return None, "Can only retry failed or cancelled jobs"

    params = dict(old.get("params", {}))
    job_type = old.get("type", "record")
    params["title"] = f"Retry — {old.get('title', job_id)}"[:120]

    new_job = create_job(job_type, params)
    runner = runner_map.get(job_type)
    if runner:
        ok, msg = start_job(new_job["id"], runner)
        if not ok:
            update_job(new_job["id"], status="failed", error=msg)
            return new_job, msg
    return new_job, "started"


def get_job(job_id):
    meta = _load_metadata(job_id)
    if meta:
        return meta
    conn = database.get_db()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row:
            return dict(row)
    finally:
        conn.close()
    return None


def list_jobs(limit=50, status_filter=None):
    conn = database.get_db()
    try:
        if status_filter:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ?",
                (status_filter, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY priority DESC, created_at DESC LIMIT ?",
                (limit,)
            ).fetchall()
        jobs = []
        for row in rows:
            job = dict(row)
            meta = _load_metadata(job["id"])
            if meta:
                job["params"] = meta.get("params", {})
            jobs.append(job)
        return jobs
    finally:
        conn.close()


def get_scheduled_ready():
    """Return queued jobs whose scheduled_at has passed."""
    now = datetime.now(timezone.utc).isoformat()
    conn = database.get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE status = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY priority DESC",
            (now,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def is_cancelled(job_id):
    flag = _cancel_flags.get(job_id)
    return flag and flag.is_set()


def _save_metadata(job_id, data):
    job_folder = get_job_folder(job_id)
    os.makedirs(job_folder, exist_ok=True)
    path = os.path.join(job_folder, "metadata.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)


def _load_metadata(job_id):
    path = os.path.join(get_job_folder(job_id), "metadata.json")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None
