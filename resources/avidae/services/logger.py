import os
import json
import logging
from datetime import datetime, timezone

_loggers = {}


def get_job_logger(job_id, job_folder):
    if job_id in _loggers:
        return _loggers[job_id]

    log_path = os.path.join(job_folder, "job.log")
    logger = logging.getLogger(f"avidae.job.{job_id}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    if not logger.handlers:
        fh = logging.FileHandler(log_path, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fmt = logging.Formatter("[%(asctime)s] %(levelname)s — %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
        fh.setFormatter(fmt)
        logger.addHandler(fh)

    _loggers[job_id] = logger
    return logger


def close_job_logger(job_id):
    logger = _loggers.pop(job_id, None)
    if logger:
        for h in logger.handlers[:]:
            h.close()
            logger.removeHandler(h)


def read_job_log(job_folder, tail=200):
    log_path = os.path.join(job_folder, "job.log")
    if not os.path.exists(log_path):
        return ""
    with open(log_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    if tail and len(lines) > tail:
        lines = lines[-tail:]
    return "".join(lines)


def append_log_event(job_folder, event_type, message, data=None):
    events_path = os.path.join(job_folder, "events.jsonl")
    event = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "message": message,
    }
    if data:
        event["data"] = data
    with open(events_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")
