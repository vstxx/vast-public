import os
import asyncio
import time
import shutil
import glob
import subprocess
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled, emit_job_update
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import (
    build_thumbnail_command, build_trim_command,
    build_extract_audio_command, run_ffmpeg
)
from utils.playwright_helper import (
    create_browser_context, navigate_and_prepare, take_preview_screenshot,
    close_context_and_browser
)


def run_record_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    meta_path = os.path.join(job_folder, "metadata.json")
    with open(meta_path, "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})

    url = params.get("url", "")
    resolution = params.get("resolution", config.DEFAULT_RESOLUTION)
    fps = int(params.get("fps", config.DEFAULT_FPS))
    bitrate = params.get("bitrate", config.DEFAULT_BITRATE)
    max_duration = int(params.get("max_duration", config.DEFAULT_MAX_DURATION))
    delay = int(params.get("delay", config.DEFAULT_DELAY))
    output_format = params.get("format", config.DEFAULT_FORMAT)
    play_selector = params.get("play_selector", "")
    video_selector = params.get("video_selector", "")
    trim_start = params.get("trim_start")
    trim_end = params.get("trim_end")
    extract_audio_flag = params.get("extract_audio", False)

    # Phase 1: Analyzing
    update_job(job_id, status="analyzing", progress=5)
    logger.info("Phase: Analyzing target page")
    append_log_event(job_folder, "phase", "Analyzing page")

    if is_cancelled(job_id):
        update_job(job_id, status="cancelled")
        return

    # Phase 2: Recording via Playwright CDP video
    update_job(job_id, status="recording", progress=10)
    logger.info("Phase: Recording")
    append_log_event(job_folder, "phase", "Recording started")

    temp_dir = os.path.join(job_folder, "temp")
    output_dir = os.path.join(job_folder, "output")
    os.makedirs(temp_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    raw_output = os.path.join(temp_dir, "raw_recording.webm")
    final_output = os.path.join(output_dir, f"recording.{output_format}")

    try:
        asyncio.run(_record_with_cdp(
            job_id=job_id,
            url=url,
            output_path=raw_output,
            resolution=resolution,
            fps=fps,
            bitrate=bitrate,
            max_duration=max_duration,
            delay=delay,
            play_selector=play_selector or None,
            video_selector=video_selector or None,
            output_format=output_format,
            cancel_flag=cancel_flag,
            logger=logger,
            temp_dir=temp_dir,
            job_folder=job_folder,
        ))
    except Exception as e:
        logger.error(f"Recording failed: {e}")
        update_job(job_id, status="failed", error=str(e))
        return

    if is_cancelled(job_id):
        update_job(job_id, status="cancelled")
        return

    if not os.path.isfile(raw_output):
        logger.error("No recording output file produced")
        update_job(job_id, status="failed", error="No recording output")
        return

    # Phase 3: Post-processing
    update_job(job_id, status="post-processing", progress=70)
    logger.info("Phase: Post-processing")
    append_log_event(job_folder, "phase", "Post-processing")

    # Trim if requested
    if trim_start or trim_end:
        logger.info(f"Trimming: start={trim_start}, end={trim_end}")
        trimmed = os.path.join(temp_dir, f"trimmed.{output_format}")
        cmd = build_trim_command(raw_output, trimmed, start=trim_start, end=trim_end)
        ok, err = run_ffmpeg(cmd, logger=logger, timeout=300)
        if ok:
            raw_output = trimmed
        else:
            logger.warning(f"Trim failed: {err}, using untrimmed")

    # Re-encode if needed (CDP produces webm, convert to desired format)
    if output_format != "webm" and raw_output.endswith(".webm"):
        if getattr(config, "FFMPEG_IS_PLAYWRIGHT", False):
            logger.warning("Production FFmpeg not found; saving WebM output instead")
            output_format = "webm"
            final_output = os.path.join(output_dir, "recording.webm")
        else:
            logger.info(f"Converting from webm to {output_format}")
            converted = os.path.join(temp_dir, f"converted.{output_format}")
            cmd = [
                config.FFMPEG_PATH, "-y", "-i", raw_output,
                "-c:v", "libx264", "-preset", "fast",
                "-b:v", bitrate, "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                converted
            ]
            ok, err = run_ffmpeg(cmd, logger=logger, timeout=600)
            if ok:
                raw_output = converted
            else:
                logger.warning(f"Conversion failed: {err}; saving WebM output instead")
                output_format = "webm"
                final_output = os.path.join(output_dir, "recording.webm")

    shutil.copy2(raw_output, final_output)
    logger.info(f"Output saved: {final_output}")
    update_job(job_id, progress=85)

    # Generate thumbnail
    thumb_path = os.path.join(job_folder, "thumbnail.jpg")
    if not getattr(config, "FFMPEG_IS_PLAYWRIGHT", False):
        cmd = build_thumbnail_command(final_output, thumb_path)
        ok, _ = run_ffmpeg(cmd, logger=logger, timeout=30)
        if ok:
            update_job(job_id, thumbnail="thumbnail.jpg")
            logger.info("Thumbnail generated")
    else:
        logger.info("Skipping thumbnail: production FFmpeg not available")

    update_job(job_id, progress=90)

    # Extract audio if requested
    if extract_audio_flag:
        logger.info("Extracting audio track")
        audio_output = os.path.join(output_dir, "audio.mp3")
        cmd = build_extract_audio_command(final_output, audio_output)
        ok, err = run_ffmpeg(cmd, logger=logger, timeout=300)
        if ok:
            logger.info("Audio extracted successfully")
        else:
            logger.warning(f"Audio extraction failed: {err}")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=f"recording.{output_format}",
    )
    logger.info(f"Job completed: {job_id}")
    append_log_event(job_folder, "completed", "Recording job finished")


async def _record_with_cdp(job_id, url, output_path, resolution, fps,
                            bitrate, max_duration, delay, play_selector,
                            video_selector, output_format, cancel_flag,
                            logger, temp_dir, job_folder):
    """Record using Playwright's native CDP-based video recording."""
    from playwright.async_api import async_playwright

    video_dir = os.path.join(temp_dir, "cdp_video")
    os.makedirs(video_dir, exist_ok=True)

    async with async_playwright() as pw:
        browser, context = await create_browser_context(
            pw, resolution, record_video_dir=video_dir
        )
        page = await context.new_page()

        try:
            await navigate_and_prepare(
                page, url,
                play_selector=play_selector,
                video_selector=video_selector,
                delay=delay,
                logger=logger,
            )

            logger.info(f"CDP recording started: {resolution}, max {max_duration}s")

            # Live preview: take periodic screenshots while CDP records
            preview_path = os.path.join(job_folder, "preview.jpg")
            start_time = time.time()
            preview_interval = getattr(config, 'PREVIEW_INTERVAL', 5)

            while True:
                elapsed = time.time() - start_time
                if elapsed >= max_duration:
                    logger.info(f"Max duration reached ({max_duration}s)")
                    break
                if cancel_flag and cancel_flag.is_set():
                    logger.info("Recording cancelled by user")
                    break

                # Update progress
                pct = min(10 + int(55 * elapsed / max_duration), 65)
                update_job(job_id, progress=pct)

                # Take a live preview screenshot
                try:
                    await take_preview_screenshot(page, preview_path, quality=40)
                except Exception:
                    pass

                await asyncio.sleep(preview_interval)

        finally:
            # Closing context finalizes the CDP video file
            await close_context_and_browser(context, browser, logger=logger)

        # Find the recorded video file
        video_files = glob.glob(os.path.join(video_dir, "*.webm"))
        if not video_files:
            raise RuntimeError("CDP video recording produced no output file")

        cdp_video = video_files[0]
        logger.info(f"CDP video saved: {cdp_video} ({os.path.getsize(cdp_video)} bytes)")

        # Playwright's native context recording always produces WebM.
        # Keep the extension truthful so the caller can convert when needed.
        shutil.move(cdp_video, output_path)
