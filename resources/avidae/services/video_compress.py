import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg, get_duration, build_thumbnail_command


def run_video_compress_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    target_bitrate = params.get("bitrate", "2M")
    resolution = params.get("resolution", "")
    crf = params.get("crf", "")
    preset = params.get("preset", "medium")
    audio_bitrate = params.get("audio_bitrate", "128k")

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Video Compress: {input_file}")

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
    orig_size = os.path.getsize(input_file)
    logger.info(f"Input: {total_duration:.1f}s, {orig_size / (1024*1024):.1f} MB")

    basename = os.path.splitext(os.path.basename(input_file))[0]
    ext = os.path.splitext(input_file)[1] or ".mp4"
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}_compressed{ext}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=15)
    append_log_event(job_folder, "phase", "Compressing video")

    # Build compress command
    cmd = [config.FFMPEG_PATH, "-y", "-i", input_file]
    cmd += ["-c:v", "libx264", "-preset", preset]

    if crf:
        # CRF mode (quality-based)
        cmd += ["-crf", str(crf)]
        logger.info(f"CRF mode: crf={crf}, preset={preset}")
    else:
        # Bitrate mode
        cmd += ["-b:v", target_bitrate]
        logger.info(f"Bitrate mode: {target_bitrate}, preset={preset}")

    if resolution:
        w, h = resolution.split("x")
        cmd += ["-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease"]
        logger.info(f"Scaling to {resolution}")

    cmd += ["-c:a", "aac", "-b:a", audio_bitrate]
    cmd += ["-movflags", "+faststart", output_path]

    def on_progress(pct, info):
        scaled = 15 + int(pct * 0.7)
        update_job(job_id, progress=scaled)

    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION * 2,
        progress_callback=on_progress, total_duration=total_duration
    )

    if not ok:
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning("FFmpeg exited with errors but output exists, continuing")
        else:
            logger.error(f"Compression failed: {err}")
            update_job(job_id, status="failed", error=f"Compression failed: {err[:200]}")
            return

    update_job(job_id, status="post-processing", progress=85)

    # Report compression ratio
    if os.path.isfile(output_path):
        new_size = os.path.getsize(output_path)
        ratio = (1 - new_size / orig_size) * 100 if orig_size > 0 else 0
        logger.info(f"Output: {new_size / (1024*1024):.1f} MB ({ratio:.0f}% smaller)")

    # Thumbnail
    thumb_path = os.path.join(job_folder, "thumbnail.jpg")
    cmd_t = build_thumbnail_command(output_path, thumb_path)
    ok_t, _ = run_ffmpeg(cmd_t, logger=logger, timeout=30)
    if ok_t:
        update_job(job_id, thumbnail="thumbnail.jpg")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Video compression completed: {job_id}")
    append_log_event(job_folder, "completed", "Video compression finished")
