import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg, get_duration, build_thumbnail_command


def run_video_trim_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    start_time = params.get("start_time", "")
    end_time = params.get("end_time", "")
    reencode = params.get("reencode", False)

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Video Trim: {input_file}")

    if not os.path.isfile(input_file):
        uploads_path = os.path.join(config.UPLOADS_DIR, os.path.basename(input_file))
        if os.path.isfile(uploads_path):
            input_file = uploads_path
        else:
            logger.error(f"Input file not found: {input_file}")
            update_job(job_id, status="failed", error="Input file not found")
            return

    if is_cancelled(job_id):
        update_job(job_id, status="cancelled")
        return

    total_duration = get_duration(input_file)
    logger.info(f"Input duration: {total_duration:.1f}s")

    if not start_time and not end_time:
        logger.error("No start or end time specified")
        update_job(job_id, status="failed", error="Specify at least start or end time")
        return

    basename = os.path.splitext(os.path.basename(input_file))[0]
    ext = os.path.splitext(input_file)[1] or ".mp4"
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}_trimmed{ext}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=20)
    logger.info(f"Trimming: {start_time or '0'} → {end_time or 'end'} (reencode={reencode})")
    append_log_event(job_folder, "phase", "Trimming video")

    # Build trim command
    cmd = [config.FFMPEG_PATH, "-y"]
    if start_time:
        cmd += ["-ss", str(start_time)]
    cmd += ["-i", input_file]
    if end_time:
        cmd += ["-to", str(end_time)]
    if reencode:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-c:a", "aac"]
    else:
        cmd += ["-c", "copy"]
    cmd += ["-movflags", "+faststart", output_path]

    # Calculate effective duration for progress
    s = _parse_time(start_time) if start_time else 0
    e = _parse_time(end_time) if end_time else total_duration
    eff_duration = max(e - s, 1)

    def on_progress(pct, info):
        scaled = 20 + int(pct * 0.65)
        update_job(job_id, progress=scaled)

    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=eff_duration
    )

    if not ok:
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning("FFmpeg exited with errors but output exists, continuing")
        else:
            logger.error(f"Trim failed: {err}")
            update_job(job_id, status="failed", error=f"Trim failed: {err[:200]}")
            return

    update_job(job_id, status="post-processing", progress=85)

    # Thumbnail
    thumb_path = os.path.join(job_folder, "thumbnail.jpg")
    cmd_t = build_thumbnail_command(output_path, thumb_path)
    ok_t, _ = run_ffmpeg(cmd_t, logger=logger, timeout=30)
    if ok_t:
        update_job(job_id, thumbnail="thumbnail.jpg")

    out_duration = get_duration(output_path)
    logger.info(f"Output duration: {out_duration:.1f}s")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Video trim completed: {job_id}")
    append_log_event(job_folder, "completed", "Video trim finished")


def _parse_time(ts):
    """Parse time string to seconds. Supports HH:MM:SS, MM:SS, or seconds."""
    ts = str(ts).strip()
    if ":" in ts:
        parts = ts.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    return float(ts)
