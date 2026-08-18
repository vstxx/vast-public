import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import (
    build_convert_command, build_thumbnail_command, run_ffmpeg, get_duration
)


def run_convert_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    output_format = params.get("format", "mp4")
    vcodec = params.get("vcodec", "libx264")
    acodec = params.get("acodec", "aac")
    bitrate = params.get("bitrate")
    resolution = params.get("resolution")

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Converting: {input_file} → .{output_format}")

    if not os.path.isfile(input_file):
        # Check uploads dir
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

    # Get duration for progress tracking
    total_duration = get_duration(input_file)
    logger.info(f"Input duration: {total_duration:.1f}s")

    basename = os.path.splitext(os.path.basename(input_file))[0]
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}.{output_format}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=20)
    logger.info("Running FFmpeg conversion...")
    append_log_event(job_folder, "phase", "Converting")

    def on_progress(pct, info):
        # Scale 0-100 to 20-85 range
        scaled = 20 + int(pct * 0.65)
        update_job(job_id, progress=scaled)

    cmd = build_convert_command(
        input_file, output_path,
        vcodec=vcodec, acodec=acodec,
        bitrate=bitrate, resolution=resolution
    )
    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=total_duration
    )

    if not ok:
        logger.error(f"Conversion failed: {err}")
        update_job(job_id, status="failed", error=f"FFmpeg conversion failed: {err[:200]}")
        return

    update_job(job_id, status="post-processing", progress=85)

    # Thumbnail
    thumb_path = os.path.join(job_folder, "thumbnail.jpg")
    cmd = build_thumbnail_command(output_path, thumb_path)
    ok, _ = run_ffmpeg(cmd, logger=logger, timeout=30)
    if ok:
        update_job(job_id, thumbnail="thumbnail.jpg")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Conversion completed: {job_id}")
    append_log_event(job_folder, "completed", "Conversion finished")
