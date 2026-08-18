import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg, get_duration


AUDIO_CODECS = {
    "ogg": "libvorbis",
    "opus": "libopus",
    "mp3": "libmp3lame",
    "wav": "pcm_s16le",
    "flac": "flac",
    "aac": "aac",
    "m4a": "aac",
}


def build_audio_convert_command(input_path, output_path, acodec, bitrate="192k",
                                sample_rate=None, channels=None):
    cmd = [config.FFMPEG_PATH, "-y", "-i", input_path, "-vn", "-c:a", acodec]
    if acodec not in ("pcm_s16le", "flac"):
        if acodec == "libvorbis":
            # Use VBR quality mode — fixed bitrate fails when combined
            # with low sample rates or mono (encoder setup error).
            _vorbis_q = {
                "64k": 0, "96k": 2, "128k": 4, "160k": 5,
                "192k": 6, "256k": 8, "320k": 9,
            }
            cmd += ["-q:a", str(_vorbis_q.get(bitrate, 4))]
        else:
            cmd += ["-b:a", bitrate]
    if sample_rate:
        cmd += ["-ar", str(sample_rate)]
    if channels:
        cmd += ["-ac", str(channels)]
    cmd += [output_path]
    return cmd


def run_audio_convert_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_file = params.get("input_file", "")
    output_format = params.get("format", "ogg")
    bitrate = params.get("bitrate", "192k")
    sample_rate = params.get("sample_rate")
    channels = params.get("channels")

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Audio convert: {input_file} → .{output_format}")

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

    acodec = AUDIO_CODECS.get(output_format, "libvorbis")
    basename = os.path.splitext(os.path.basename(input_file))[0]
    safe_name = re.sub(r'[^\w\-_]', '_', basename)
    output_name = f"{safe_name}.{output_format}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # For same-format conversion (e.g. OGG→OGG) ensure we re-encode, not copy
    input_ext = os.path.splitext(input_file)[1].lower().lstrip(".")
    force_reencode = (input_ext == output_format)

    update_job(job_id, status="recording", progress=15)
    logger.info(f"Running FFmpeg: {acodec} @ {bitrate}"
                + (f", ar={sample_rate}" if sample_rate else "")
                + (f", ac={channels}" if channels else "")
                + (" (re-encode)" if force_reencode else ""))
    append_log_event(job_folder, "phase", "Converting audio")

    def on_progress(pct, info):
        scaled = 15 + int(pct * 0.75)
        update_job(job_id, progress=scaled)

    cmd = build_audio_convert_command(
        input_file, output_path, acodec,
        bitrate=bitrate, sample_rate=sample_rate, channels=channels
    )
    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=total_duration
    )

    if not ok:
        # libvorbis may exit non-zero due to "backward in time" warnings
        # while still producing valid output — check before giving up.
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning(f"FFmpeg exited with errors but output exists, continuing")
        else:
            logger.error(f"Audio conversion failed: {err}")
            update_job(job_id, status="failed", error=f"FFmpeg failed: {err[:200]}")
            return

    # Verify output file was actually created and has content
    if not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
        logger.error("Output file missing or empty after conversion")
        update_job(job_id, status="failed", error="Conversion produced no output")
        return

    update_job(job_id, status="post-processing", progress=92)

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Audio conversion completed: {output_name}")
    append_log_event(job_folder, "completed", "Audio conversion finished")
