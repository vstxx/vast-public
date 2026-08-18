import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import build_extract_audio_command, run_ffmpeg, get_duration


def run_extract_audio_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    audio_format = params.get("audio_format", "mp3")
    acodec = params.get("acodec", "libmp3lame")
    bitrate = params.get("audio_bitrate", "192k")

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Extracting audio: {input_file} → .{audio_format}")

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

    basename = os.path.splitext(os.path.basename(input_file))[0]
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}.{audio_format}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=20)
    logger.info("Running FFmpeg audio extraction...")
    append_log_event(job_folder, "phase", "Extracting audio")

    def on_progress(pct, info):
        scaled = 20 + int(pct * 0.7)
        update_job(job_id, progress=scaled)

    cmd = build_extract_audio_command(input_file, output_path, acodec=acodec, bitrate=bitrate)
    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=total_duration
    )

    if not ok:
        logger.error(f"Audio extraction failed: {err}")
        update_job(job_id, status="failed", error=f"FFmpeg extraction failed: {err[:200]}")
        return

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Audio extraction completed: {job_id}")
    append_log_event(job_folder, "completed", "Audio extraction finished")
