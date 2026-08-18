import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg, get_duration


def run_audio_trim_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    start_time = params.get("start_time", "")
    end_time = params.get("end_time", "")
    fade_in = float(params.get("fade_in", 0))
    fade_out = float(params.get("fade_out", 0))

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Audio Trim: {input_file}")

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
    ext = os.path.splitext(input_file)[1] or ".mp3"
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}_trimmed{ext}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=20)
    logger.info(f"Trimming: {start_time or '0'} → {end_time or 'end'}")
    if fade_in > 0 or fade_out > 0:
        logger.info(f"Fades: in={fade_in}s, out={fade_out}s")
    append_log_event(job_folder, "phase", "Trimming audio")

    # Build command
    cmd = [config.FFMPEG_PATH, "-y"]
    if start_time:
        cmd += ["-ss", str(start_time)]
    cmd += ["-i", input_file]
    if end_time:
        cmd += ["-to", str(end_time)]

    # Build audio filter chain for fades
    filters = []
    if fade_in > 0:
        filters.append(f"afade=t=in:st=0:d={fade_in}")
    if fade_out > 0:
        # Calculate fade-out start time relative to trimmed output
        s = _parse_time(start_time) if start_time else 0
        e = _parse_time(end_time) if end_time else total_duration
        out_dur = e - s
        fade_start = max(out_dur - fade_out, 0)
        filters.append(f"afade=t=out:st={fade_start}:d={fade_out}")

    if filters:
        cmd += ["-af", ",".join(filters)]
        # Must re-encode when using filters
        cmd += ["-c:a", _get_codec(ext)]
    else:
        cmd += ["-c", "copy"]

    cmd += [output_path]

    # Progress tracking
    s = _parse_time(start_time) if start_time else 0
    e = _parse_time(end_time) if end_time else total_duration
    eff_duration = max(e - s, 1)

    def on_progress(pct, info):
        scaled = 20 + int(pct * 0.7)
        update_job(job_id, progress=scaled)

    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=eff_duration
    )

    if not ok:
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning("FFmpeg exited with errors but output exists, continuing")
        else:
            logger.error(f"Audio trim failed: {err}")
            update_job(job_id, status="failed", error=f"Trim failed: {err[:200]}")
            return

    out_dur = get_duration(output_path)
    logger.info(f"Output duration: {out_dur:.1f}s")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Audio trim completed: {job_id}")
    append_log_event(job_folder, "completed", "Audio trim finished")


def _parse_time(ts):
    """Parse time string to seconds."""
    ts = str(ts).strip()
    if ":" in ts:
        parts = ts.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    return float(ts)


def _get_codec(ext):
    """Get appropriate audio codec for file extension."""
    return {
        ".mp3": "libmp3lame",
        ".ogg": "libvorbis",
        ".opus": "libopus",
        ".wav": "pcm_s16le",
        ".flac": "flac",
        ".aac": "aac",
        ".m4a": "aac",
    }.get(ext.lower(), "libmp3lame")
