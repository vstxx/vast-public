import os
import csv
import io
import json
import ipaddress
import mimetypes
import re
import subprocess
import sys
import threading
import hmac
from datetime import datetime, timezone
from urllib.parse import urlparse


def _runtime_self_test():
    """Fail closed when a packaged media runtime is incomplete."""
    import importlib.metadata

    ffmpeg = os.environ.get("FFMPEG_PATH", "")
    ffprobe = os.environ.get("FFPROBE_PATH", "")
    browsers = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
    for label, executable in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)):
        if not executable or not os.path.isfile(executable):
            raise RuntimeError(f"Bundled {label} is missing")
        result = subprocess.run(
            [executable, "-version"], capture_output=True, text=True, timeout=15, check=False
        )
        if result.returncode != 0:
            raise RuntimeError(f"Bundled {label} failed its version check")
    if not browsers or not os.path.isdir(browsers):
        raise RuntimeError("Bundled Playwright browser directory is missing")
    chromium = []
    for root, _dirs, files in os.walk(browsers):
        if "chrome.exe" in files:
            chromium.append(os.path.join(root, "chrome.exe"))
    if not chromium:
        raise RuntimeError("Bundled Playwright Chromium is missing")
    print(json.dumps({
        "ok": True,
        "python": sys.version.split()[0],
        "playwright": importlib.metadata.version("playwright"),
        "chromium": os.path.basename(os.path.dirname(chromium[0])),
    }))


if "--runtime-self-test" in sys.argv:
    _runtime_self_test()
    raise SystemExit(0)

from flask import Flask, render_template, request, jsonify, send_file, abort, Response
from flask_socketio import SocketIO
from werkzeug.utils import secure_filename

import config
import database
from services.job_manager import (
    create_job, start_job, get_job, list_jobs,
    cancel_job, delete_job, update_job, retry_job,
    set_socketio, get_scheduled_ready
)
from services.recorder import run_record_job
from services.downloader import run_download_job
from services.converter import run_convert_job
from services.audio_extractor import run_extract_audio_job
from services.audio_converter import run_audio_convert_job
from services.video_trim import run_video_trim_job
from services.video_merge import run_video_merge_job
from services.video_compress import run_video_compress_job
from services.audio_record import run_audio_record_job, list_audio_devices
from services.audio_trim import run_audio_trim_job
from services.browse_session import BrowseSessionManager
from services.logger import read_job_log
from services.storage import (
    get_file_path, get_output_files, get_disk_usage, format_size, save_upload
)
from utils.playwright_helper import analyze_page_sync
from security import is_public_url

app = Flask(__name__)
app.secret_key = config.SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_SIZE
AUTH_TOKEN = os.environ.get("AVIDAE_AUTH_TOKEN", "")
EMBEDDED = os.environ.get("AVIDAE_EMBEDDED") == "1"
if EMBEDDED and len(AUTH_TOKEN) < 32:
    raise RuntimeError("Embedded Video & Audio requires a per-launch authentication token")

socketio = SocketIO(app, cors_allowed_origins=[], async_mode="threading")

# Wire SocketIO into job_manager for real-time updates
set_socketio(socketio)

# Browse session manager
browse_manager = BrowseSessionManager()

# Initialize database
database.init_db()

# Runner map for retry/schedule
RUNNERS = {
    "record": run_record_job,
    "download": run_download_job,
    "convert": run_convert_job,
    "extract_audio": run_extract_audio_job,
    "audio_convert": run_audio_convert_job,
    "video_trim": run_video_trim_job,
    "video_merge": run_video_merge_job,
    "video_compress": run_video_compress_job,
    "audio_record": run_audio_record_job,
    "audio_trim": run_audio_trim_job,
}


# ==================== Scheduler Thread ====================

def _scheduler_loop():
    """Check for scheduled jobs every 2 seconds."""
    import time
    while True:
        try:
            ready = get_scheduled_ready()
            for job_data in ready:
                jid = job_data["id"]
                jtype = job_data.get("type", "record")
                runner = RUNNERS.get(jtype)
                if runner:
                    start_job(jid, runner)
        except Exception:
            pass
        time.sleep(2)

_sched_thread = threading.Thread(target=_scheduler_loop, daemon=True)
_sched_thread.start()


def _sanitize_job(job):
    if not job:
        return None
    clean = dict(job)
    clean.pop("folder", None)
    clean.pop("params", None)
    return clean


def _sanitize_jobs(jobs):
    return [_sanitize_job(job) for job in jobs]


def _bounded_limit(value, default=50, maximum=1000):
    if not isinstance(value, int):
        return default
    return max(1, min(value, maximum))


def _bounded_job_ids(data):
    raw_ids = data.get("job_ids", []) if isinstance(data, dict) else []
    if not isinstance(raw_ids, list):
        return []
    return [str(job_id) for job_id in raw_ids[:500] if str(job_id).strip()]


def _job_title(job):
    return job.get("title") or job.get("params", {}).get("title") or ""


def _is_safe_analysis_url(raw_url):
    return is_public_url(raw_url)


def _allow_socket_origin(origin_value):
    if not origin_value:
        return True
    try:
        parsed = urlparse(origin_value)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        return False
    return parsed.netloc.lower() == request.host.lower()


def _authorized_request():
    authorization = request.headers.get("Authorization", "")
    expected = "Bearer " + AUTH_TOKEN
    return bool(AUTH_TOKEN) and hmac.compare_digest(authorization, expected)


def _approved_path(candidate, must_exist=True):
    if not isinstance(candidate, str) or not candidate or "\x00" in candidate:
        return None
    roots = [config.DATA_DIR, config.UPLOADS_DIR, config.DOWNLOADS_DIR, config.JOBS_DIR]
    try:
        resolved = os.path.realpath(candidate)
        if must_exist and not os.path.exists(resolved):
            return None
        for root in roots:
            canonical_root = os.path.realpath(root)
            if os.path.commonpath([canonical_root, resolved]) == canonical_root:
                return resolved
    except (OSError, ValueError):
        return None
    return None


@app.before_request
def enforce_local_security_boundary():
    expected_hosts = {f"127.0.0.1:{os.environ.get('PORT', '5000')}", f"localhost:{os.environ.get('PORT', '5000')}"}
    if request.host.lower() not in expected_hosts:
        return jsonify({"ok": False, "error": "Invalid Host"}), 400
    if not _authorized_request():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    origin = request.headers.get("Origin", "")
    if origin and not _allow_socket_origin(origin):
        return jsonify({"ok": False, "error": "Invalid Origin"}), 403
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH") and request.content_length:
        expected = "multipart/form-data" if request.path == "/api/upload" else "application/json"
        if not (request.content_type or "").lower().startswith(expected):
            return jsonify({"ok": False, "error": "Unsupported content type"}), 415
    job_id = (request.view_args or {}).get("job_id")
    if job_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(job_id)):
        return jsonify({"ok": False, "error": "Invalid job id"}), 400


@app.after_request
def harden_local_response(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


# ==================== SocketIO Events ====================

@socketio.on("connect")
def on_connect():
    origin = request.headers.get("Origin", "")
    if not _allow_socket_origin(origin) or not _authorized_request():
        return False


@socketio.on("request_job_update")
def on_request_job_update(data):
    job_id = data.get("job_id", "")
    job = get_job(job_id)
    if job:
        socketio.emit("job_update", _sanitize_job(job))


# ==================== Browse Session Events ====================

@socketio.on("browse_start")
def on_browse_start(data):
    url = (data.get("url") or "").strip()
    if not url or not _is_safe_analysis_url(url):
        socketio.emit("browse_error", {"error": "URL is required", "session_id": ""})
        return
    sid = data.get("session_id", "")
    if not sid:
        import uuid
        sid = uuid.uuid4().hex[:12]
    browse_manager.start_session(
        sid, url, socketio,
        resolution=data.get("resolution", "1920x1080"),
        auto_record=data.get("auto_record", True),
        output_format=data.get("format", "mp4"),
        bitrate=data.get("bitrate", "5M"),
    )


@socketio.on("browse_click")
def on_browse_click(data):
    browse_manager.click(
        data.get("session_id", ""),
        data.get("x", 0), data.get("y", 0)
    )


@socketio.on("browse_scroll")
def on_browse_scroll(data):
    browse_manager.scroll(
        data.get("session_id", ""),
        data.get("x", 0), data.get("y", 0), data.get("delta", 0)
    )


@socketio.on("browse_stop")
def on_browse_stop(data):
    browse_manager.stop_session(data.get("session_id", ""), save=True)


@socketio.on("browse_cancel")
def on_browse_cancel(data):
    browse_manager.stop_session(data.get("session_id", ""), save=False)


# ==================== UI Routes ====================

@app.route("/")
def page_dashboard():
    return render_template("dashboard.html", page="dashboard")


@app.route("/record")
def page_record():
    return render_template("record.html", page="record")


@app.route("/download")
def page_download():
    return render_template("download.html", page="download")


@app.route("/convert")
def page_convert():
    return render_template("convert.html", page="convert")


@app.route("/extract-audio")
def page_extract_audio():
    return render_template("extract_audio.html", page="extract")


@app.route("/audio-convert")
def page_audio_convert():
    return render_template("audio_convert.html", page="audio_convert")


@app.route("/video-trim")
def page_video_trim():
    return render_template("video_trim.html", page="video_trim")


@app.route("/video-merge")
def page_video_merge():
    return render_template("video_merge.html", page="video_merge")


@app.route("/video-compress")
def page_video_compress():
    return render_template("video_compress.html", page="video_compress")


@app.route("/audio-record")
def page_audio_record():
    return render_template("audio_record.html", page="audio_record")


@app.route("/audio-trim")
def page_audio_trim():
    return render_template("audio_trim.html", page="audio_trim")


@app.route("/jobs")
def page_jobs():
    return render_template("jobs.html", page="jobs")


@app.route("/settings")
def page_settings():
    return render_template("settings.html", page="settings", config=config)


# ==================== API Routes ====================

@app.route("/api/jobs", methods=["GET"])
def api_list_jobs():
    limit = _bounded_limit(request.args.get("limit", 50, type=int), default=50, maximum=1000)
    status = request.args.get("status", None)
    jobs = _sanitize_jobs(list_jobs(limit=limit, status_filter=status))
    return jsonify({"ok": True, "jobs": jobs})


@app.route("/api/jobs", methods=["POST"])
def api_create_job():
    data = request.get_json()
    if not data:
        return jsonify({"ok": False, "error": "No JSON body"}), 400

    job_type = data.get("type", "")
    params = data.get("params", {})
    if not isinstance(params, dict):
        return jsonify({"ok": False, "error": "Invalid job parameters"}), 400

    if job_type not in RUNNERS:
        return jsonify({"ok": False, "error": f"Unknown job type: {job_type}"}), 400

    if job_type == "record" and not params.get("url"):
        return jsonify({"ok": False, "error": "URL is required for recording"}), 400
    if job_type == "download" and not params.get("url"):
        return jsonify({"ok": False, "error": "URL is required for download"}), 400
    if job_type in ("record", "download") and not _is_safe_analysis_url(params.get("url", "")):
        return jsonify({"ok": False, "error": "Only public http(s) URLs are allowed"}), 400
    if job_type == "video_merge" and (not params.get("input_files") or len(params.get("input_files", [])) < 2):
        return jsonify({"ok": False, "error": "At least 2 input files required"}), 400
    if job_type in ("convert", "extract_audio", "audio_convert", "video_trim", "video_compress", "audio_trim") and not params.get("input_file"):
        return jsonify({"ok": False, "error": "Input file is required"}), 400

    if job_type in ("convert", "extract_audio", "audio_convert", "video_trim", "video_compress", "audio_trim"):
        input_file = params.get("input_file", "")
        approved_input = _approved_path(input_file)
        if not approved_input:
            uploads_path = os.path.join(config.UPLOADS_DIR, os.path.basename(input_file))
            approved_input = _approved_path(uploads_path)
            if approved_input:
                params["input_file"] = approved_input
            else:
                return jsonify({"ok": False, "error": "Input file not found"}), 400
        else:
            params["input_file"] = approved_input
    if job_type == "video_merge":
        approved_files = [_approved_path(item) for item in params.get("input_files", [])]
        if not approved_files or any(item is None for item in approved_files):
            return jsonify({"ok": False, "error": "One or more input files are outside Video & Audio storage"}), 400
        params["input_files"] = approved_files

    # Scheduled job — create but don't start immediately
    scheduled_at = params.pop("scheduled_at", None)
    if scheduled_at:
        params["scheduled_at"] = scheduled_at
        job = create_job(job_type, params)
        return jsonify({"ok": True, "job_id": job["id"], "scheduled": True})

    job = create_job(job_type, params)
    runner = RUNNERS[job_type]
    ok, msg = start_job(job["id"], runner)
    if not ok:
        update_job(job["id"], status="failed", error=msg)
        return jsonify({"ok": False, "error": msg, "job_id": job["id"]}), 429

    return jsonify({"ok": True, "job_id": job["id"]})


@app.route("/api/jobs/<job_id>", methods=["GET"])
def api_get_job(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"ok": False, "error": "Job not found"}), 404
    return jsonify(_sanitize_job(job))


@app.route("/api/jobs/<job_id>/logs", methods=["GET"])
def api_get_logs(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"ok": False, "error": "Job not found"}), 404
    folder = job.get("folder", "")
    logs = read_job_log(folder)
    return jsonify({"ok": True, "logs": logs})


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def api_cancel_job(job_id):
    ok = cancel_job(job_id)
    if ok:
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Cannot cancel this job"}), 400


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def api_delete_job(job_id):
    ok = delete_job(job_id)
    if ok:
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Job not found"}), 404


@app.route("/api/jobs/<job_id>/retry", methods=["POST"])
def api_retry_job(job_id):
    new_job, msg = retry_job(job_id, RUNNERS)
    if not new_job:
        return jsonify({"ok": False, "error": msg}), 400
    return jsonify({"ok": True, "job_id": new_job["id"], "message": msg})


@app.route("/api/jobs/<job_id>/download/<filename>")
def api_download_file(job_id, filename):
    safe_name = os.path.basename(filename)
    path = get_file_path(job_id, safe_name)
    path = _approved_path(path) if path else None
    if not path:
        abort(404)
    # Use job title as download filename when file is generic (e.g. "recording.mp4")
    ext = os.path.splitext(safe_name)[1]
    if safe_name.startswith("recording") and ext:
        job = get_job(job_id)
        if job:
            title = _job_title(job)
            if title:
                safe_title = re.sub(r'[^\w\s\-]', '', title).strip()[:120]
                if safe_title:
                    safe_name = f"{safe_title}{ext}"
    return send_file(path, as_attachment=True, download_name=safe_name)


@app.route("/api/audio-devices", methods=["GET"])
def api_audio_devices():
    """List available audio input devices."""
    devices = list_audio_devices()
    return jsonify({"ok": True, "devices": devices})


@app.route("/api/jobs/<job_id>/files", methods=["GET"])
def api_list_files(job_id):
    files = get_output_files(job_id)
    return jsonify({"ok": True, "files": files})


@app.route("/api/jobs/<job_id>/preview", methods=["GET"])
def api_preview(job_id):
    """Return the live preview JPEG or the finished video thumbnail."""
    job = get_job(job_id)
    if not job:
        abort(404)
    folder = job.get("folder", "")
    folder = _approved_path(folder)
    if not folder:
        abort(404)

    # Live preview during recording
    preview = os.path.join(folder, "preview.jpg")
    if os.path.isfile(preview):
        return send_file(preview, mimetype="image/jpeg")

    # Thumbnail for completed jobs
    thumb = os.path.join(folder, "thumbnail.jpg")
    if os.path.isfile(thumb):
        return send_file(thumb, mimetype="image/jpeg")

    abort(404)


@app.route("/api/jobs/<job_id>/stream", methods=["GET"])
def api_stream_video(job_id):
    """Stream the output video file for in-browser preview player."""
    job = get_job(job_id)
    if not job:
        abort(404)
    output_file = job.get("output_file")
    if not output_file:
        abort(404)
    folder = job.get("folder", "")
    path = os.path.join(folder, "output", output_file)
    path = _approved_path(path)
    if not path or not os.path.isfile(path):
        abort(404)
    # Build a proper filename from job title so "Save video as" works
    ext = os.path.splitext(output_file)[1] or ".mp4"
    title = _job_title(job)
    if title:
        safe_title = re.sub(r'[^\w\s\-]', '', title).strip()[:120]
        download_name = f"{safe_title}{ext}" if safe_title else output_file
    else:
        download_name = output_file
    resp = send_file(path, mimetype=mimetypes.guess_type(path)[0] or "application/octet-stream")
    resp.headers["Content-Disposition"] = f'inline; filename="{download_name}"'
    return resp


# ==================== Upload Route ====================

@app.route("/api/upload", methods=["POST"])
def api_upload():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file in request"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "Empty filename"}), 400

    filename = secure_filename(f.filename)
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext not in config.ALLOWED_UPLOAD_EXTENSIONS:
        return jsonify({"ok": False, "error": f"File type .{ext} not allowed"}), 400

    saved_path = save_upload(f, filename)
    return jsonify({"ok": True, "path": saved_path, "filename": filename})


# ==================== Batch Operations ====================

@app.route("/api/batch/cancel", methods=["POST"])
def api_batch_cancel():
    data = request.get_json() or {}
    ids = _bounded_job_ids(data)
    results = {}
    for jid in ids:
        results[jid] = cancel_job(jid)
    return jsonify({"ok": True, "results": results})


@app.route("/api/batch/delete", methods=["POST"])
def api_batch_delete():
    data = request.get_json() or {}
    ids = _bounded_job_ids(data)
    results = {}
    for jid in ids:
        results[jid] = delete_job(jid)
    return jsonify({"ok": True, "results": results})


@app.route("/api/batch/retry", methods=["POST"])
def api_batch_retry():
    data = request.get_json() or {}
    ids = _bounded_job_ids(data)
    results = {}
    for jid in ids:
        new_job, msg = retry_job(jid, RUNNERS)
        results[jid] = {"ok": new_job is not None, "message": msg}
    return jsonify({"ok": True, "results": results})


# ==================== Export ====================

@app.route("/api/export/json", methods=["GET"])
def api_export_json():
    jobs = _sanitize_jobs(list_jobs(limit=1000))
    output = json.dumps(jobs, indent=2, default=str)
    return Response(
        output,
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=video_audio_jobs.json"}
    )


@app.route("/api/export/csv", methods=["GET"])
def api_export_csv():
    jobs = _sanitize_jobs(list_jobs(limit=1000))
    if not jobs:
        return Response("No jobs", mimetype="text/csv")

    fields = ["id", "type", "status", "title", "url", "created_at", "completed_at",
              "progress", "error", "output_file", "priority"]
    si = io.StringIO()
    writer = csv.DictWriter(si, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for j in jobs:
        writer.writerow(j)

    return Response(
        si.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=video_audio_jobs.csv"}
    )


# ==================== Analyze & Stats ====================

@app.route("/api/analyze", methods=["POST"])
def api_analyze_url():
    data = request.get_json()
    url = data.get("url", "") if data else ""
    if not url:
        return jsonify({"error": "URL is required"}), 400
    if not _is_safe_analysis_url(url):
        return jsonify({"error": "Only public http(s) URLs can be analyzed."}), 400
    try:
        result = analyze_page_sync(url)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stats", methods=["GET"])
def api_stats():
    usage = get_disk_usage()
    jobs = list_jobs(limit=10000)
    return jsonify({
        "ok": True,
        "disk_usage": format_size(usage),
        "disk_bytes": usage,
        "total_jobs": len(jobs),
        "active": sum(1 for j in jobs if j.get("status") in ("queued", "analyzing", "recording", "post-processing")),
        "completed": sum(1 for j in jobs if j.get("status") == "completed"),
        "failed": sum(1 for j in jobs if j.get("status") == "failed"),
    })


# ==================== Main ====================

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("AVIDAE_HOST", "127.0.0.1" if os.environ.get("AVIDAE_EMBEDDED") else "0.0.0.0")
    print("\n  ▶ Video & Audio — Local Media Tools")
    print(f"  → http://localhost:{port}")
    print(f"  → Data: {config.DATA_DIR}\n")
    socketio.run(app, host=host, port=port, debug=config.DEBUG, allow_unsafe_werkzeug=True)
