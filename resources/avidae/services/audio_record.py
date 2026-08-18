import os
import re
import subprocess
import threading
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg


def run_audio_record_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    duration = int(params.get("duration", 60))
    audio_format = params.get("format", "mp3")
    sample_rate = params.get("sample_rate", "44100")
    channels = params.get("channels", "2")
    device = params.get("device", "")

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Audio Record: {duration}s → .{audio_format}")

    if is_cancelled(job_id):
        update_job(job_id, status="cancelled")
        return

    output_name = f"recording.{audio_format}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Build recording command based on OS
    cmd = [config.FFMPEG_PATH, "-y"]

    if os.name == "nt":
        # Windows: use DirectShow audio capture
        if device:
            audio_dev = device
        else:
            audio_dev = _detect_audio_device(logger)
            if not audio_dev:
                logger.error("No audio input device found")
                update_job(job_id, status="failed",
                          error="No audio input device found. Check microphone settings.")
                return

        cmd += ["-f", "dshow", "-i", f"audio={audio_dev}"]
        logger.info(f"Audio device: {audio_dev}")
    else:
        # Linux: use PulseAudio
        cmd += ["-f", "pulse", "-i", "default"]

    cmd += [
        "-ar", str(sample_rate),
        "-ac", str(channels),
        "-t", str(duration),
    ]

    # Codec settings per format
    codec_map = {
        "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
        "wav": ["-c:a", "pcm_s16le"],
        "ogg": ["-c:a", "libvorbis", "-q:a", "6"],
        "flac": ["-c:a", "flac"],
        "aac": ["-c:a", "aac", "-b:a", "192k"],
        "m4a": ["-c:a", "aac", "-b:a", "192k"],
    }
    cmd += codec_map.get(audio_format, ["-c:a", "libmp3lame", "-b:a", "192k"])
    cmd += [output_path]

    update_job(job_id, status="recording", progress=10)
    logger.info(f"Recording for {duration}s...")
    append_log_event(job_folder, "phase", "Recording audio")

    def on_progress(pct, info):
        scaled = 10 + int(pct * 0.85)
        update_job(job_id, progress=scaled)

    ok, err = run_ffmpeg(
        cmd, logger=logger, timeout=duration + 30,
        progress_callback=on_progress, total_duration=duration
    )

    if not ok:
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning("FFmpeg had errors but output exists, continuing")
        else:
            logger.error(f"Recording failed: {err}")
            update_job(job_id, status="failed", error=f"Recording failed: {err[:200]}")
            return

    if os.path.isfile(output_path):
        size_kb = os.path.getsize(output_path) / 1024
        logger.info(f"Recorded: {size_kb:.0f} KB")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_name,
    )
    logger.info(f"Audio recording completed: {job_id}")
    append_log_event(job_folder, "completed", "Audio recording finished")


def _detect_audio_device(logger):
    """Detect first available audio input device on Windows via DirectShow."""
    try:
        result = subprocess.run(
            [config.FFMPEG_PATH, "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True, text=True, timeout=10
        )
        stderr = result.stderr
        # Parse audio devices — look for lines with "(audio)" tag
        for line in stderr.split("\n"):
            if "(audio)" in line and '"' in line:
                match = re.search(r'"([^"]+)"', line)
                if match:
                    dev = match.group(1)
                    if dev.lower() not in ("dummy", ""):
                        logger.info(f"Detected audio device: {dev}")
                        return dev
    except Exception as e:
        logger.warning(f"Device detection failed: {e}")
    return None


def list_audio_devices():
    """Return list of available audio input devices."""
    devices = []
    try:
        result = subprocess.run(
            [config.FFMPEG_PATH, "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True, text=True, timeout=10
        )
        for line in result.stderr.split("\n"):
            if "(audio)" in line and '"' in line and "Alternative name" not in line:
                match = re.search(r'"([^"]+)"', line)
                if match and match.group(1).lower() != "dummy":
                    devices.append(match.group(1))
    except Exception:
        pass
    return devices
