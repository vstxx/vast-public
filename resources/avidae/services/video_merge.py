import os
import re
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import run_ffmpeg, get_duration, build_thumbnail_command


def run_video_merge_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    input_files = params.get("input_files", [])
    output_format = params.get("format", "mp4")
    reencode = params.get("reencode", False)

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Video Merge: {len(input_files)} files → .{output_format}")

    if len(input_files) < 2:
        logger.error("Need at least 2 files to merge")
        update_job(job_id, status="failed", error="Need at least 2 files to merge")
        return

    # Resolve all input files
    resolved = []
    for f in input_files:
        if os.path.isfile(f):
            resolved.append(f)
        else:
            up = os.path.join(config.UPLOADS_DIR, os.path.basename(f))
            if os.path.isfile(up):
                resolved.append(up)
            else:
                logger.error(f"File not found: {f}")
                update_job(job_id, status="failed", error=f"File not found: {os.path.basename(f)}")
                return

    if is_cancelled(job_id):
        update_job(job_id, status="cancelled")
        return

    # Calculate total duration
    total_duration = 0
    for f in resolved:
        d = get_duration(f)
        logger.info(f"  {os.path.basename(f)}: {d:.1f}s")
        total_duration += d
    logger.info(f"Total input duration: {total_duration:.1f}s")

    output_name = f"merged.{output_format}"
    output_path = os.path.join(job_folder, "output", output_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    update_job(job_id, status="recording", progress=15)
    append_log_event(job_folder, "phase", "Merging videos")

    if reencode:
        # Re-encode approach: handles different codecs/resolutions
        ok, err = _merge_reencode(resolved, output_path, output_format,
                                   total_duration, job_id, logger)
    else:
        # Concat demuxer approach: fast copy, requires compatible streams
        ok, err = _merge_concat(resolved, output_path, job_folder,
                                 total_duration, job_id, logger)

    if not ok:
        if os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
            logger.warning("FFmpeg had errors but output exists, continuing")
        else:
            logger.error(f"Merge failed: {err}")
            update_job(job_id, status="failed", error=f"Merge failed: {err[:200]}")
            return

    update_job(job_id, status="post-processing", progress=90)

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
    logger.info(f"Video merge completed: {job_id}")
    append_log_event(job_folder, "completed", f"Merged {len(resolved)} files")


def _merge_concat(files, output_path, job_folder, total_duration, job_id, logger):
    """Fast merge using concat demuxer (stream copy, same codec required)."""
    # Write concat list file
    list_path = os.path.join(job_folder, "concat_list.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for fp in files:
            safe = fp.replace("\\", "/").replace("'", "'\\''")
            f.write(f"file '{safe}'\n")

    logger.info("Using concat demuxer (stream copy)")

    cmd = [
        config.FFMPEG_PATH, "-y",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        "-movflags", "+faststart",
        output_path
    ]

    def on_progress(pct, info):
        scaled = 15 + int(pct * 0.75)
        update_job(job_id, progress=scaled)

    return run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION,
        progress_callback=on_progress, total_duration=total_duration
    )


def _merge_reencode(files, output_path, output_format, total_duration, job_id, logger):
    """Merge with re-encoding — handles different codecs/resolutions."""
    logger.info("Using filter_complex concat (re-encoding)")

    n = len(files)
    inputs = []
    for f in files:
        inputs += ["-i", f]

    # Build filter: normalize all to same resolution then concat
    filter_parts = []
    for i in range(n):
        filter_parts.append(f"[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
                           f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]")
        filter_parts.append(f"[{i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{i}]")

    # concat expects segments in order: [v0][a0][v1][a1]... (video+audio per segment)
    segment_inputs = "".join(f"[v{i}][a{i}]" for i in range(n))
    filter_parts.append(f"{segment_inputs}concat=n={n}:v=1:a=1[outv][outa]")

    filter_complex = ";".join(filter_parts)

    cmd = [config.FFMPEG_PATH, "-y"] + inputs + [
        "-filter_complex", filter_complex,
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "medium",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path
    ]

    def on_progress(pct, info):
        scaled = 15 + int(pct * 0.75)
        update_job(job_id, progress=scaled)

    return run_ffmpeg(
        cmd, logger=logger, timeout=config.DEFAULT_MAX_DURATION * 2,
        progress_callback=on_progress, total_duration=total_duration
    )
