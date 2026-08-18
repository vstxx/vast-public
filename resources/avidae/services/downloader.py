import os
import re
import urllib.parse
import urllib.request
import ssl
from datetime import datetime, timezone

import config
from services.job_manager import update_job, is_cancelled
from services.logger import get_job_logger, append_log_event
from services.storage import get_job_folder
from utils.ffmpeg_helper import build_thumbnail_command, run_ffmpeg
from security import resolve_public_url, safe_urlopen

MAX_REMOTE_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024


# ---- Helpers ----

def _is_tezfiles_url(url):
    """Check if URL is a TezFiles file page."""
    return bool(re.match(r"https?://(?:www\.)?tezfiles\.com/file/", url))

def _is_youtube_url(url):
    """Check if URL is a YouTube video page."""
    return bool(re.match(
        r"https?://(?:www\.|m\.|music\.)?(?:youtube\.com/(?:watch|shorts/)|youtu\.be/)",
        url, re.I,
    ))

def _is_pornhub_url(url):
    """Check if URL is a PornHub video page."""
    return bool(re.match(r"https?://(?:\w+\.)?pornhub\.com/view_video\.php", url, re.I))

def is_direct_url(url):
    """Check if URL points directly to a media file."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    path = parsed.path.lower()
    ext = os.path.splitext(path)[1]
    return ext in config.ALLOWED_DOWNLOAD_EXTENSIONS


YTDLP_DOMAINS = {
    "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
    "music.youtube.com", "vimeo.com", "twitch.tv", "www.twitch.tv",
    "dailymotion.com", "www.dailymotion.com", "twitter.com", "x.com",
    "tiktok.com", "www.tiktok.com", "facebook.com", "www.facebook.com",
    "instagram.com", "www.instagram.com", "soundcloud.com",
    "www.soundcloud.com", "reddit.com", "www.reddit.com",
}


def is_platform_url(url):
    """Check if URL is from a supported platform (yt-dlp)."""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
        return host in YTDLP_DOMAINS
    except Exception:
        return False


# ---- yt-dlp download ----

def _export_cookies_via_playwright(url, cookie_path, logger=None):
    """Use Playwright to visit a URL and export cookies in Netscape format."""
    import asyncio
    import threading
    from utils.playwright_helper import create_browser_context, close_context_and_browser

    result = [False]

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_do_export(url, cookie_path))
            result[0] = True
        except Exception as e:
            if logger:
                logger.error(f"Cookie export failed: {e}")
        finally:
            loop.close()

    async def _do_export(page_url, out_path):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser, ctx = await create_browser_context(pw, "1280x720")
            page = await ctx.new_page()
            await page.goto(page_url, wait_until="domcontentloaded", timeout=30000)
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            cookies = await ctx.cookies()
            # Write Netscape cookie file format
            with open(out_path, "w") as f:
                f.write("# Netscape HTTP Cookie File\n")
                for c in cookies:
                    domain = c.get("domain", "")
                    flag = "TRUE" if domain.startswith(".") else "FALSE"
                    path = c.get("path", "/")
                    secure = "TRUE" if c.get("secure") else "FALSE"
                    expires = str(int(c.get("expires", 0)))
                    name = c.get("name", "")
                    value = c.get("value", "")
                    f.write(f"{domain}\t{flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")
            await close_context_and_browser(ctx, browser)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=45)
    return result[0]


def _download_with_ytdlp(job_id, url, job_folder, logger, cancel_flag):
    """Download media from YouTube / platforms using yt-dlp."""
    try:
        import yt_dlp
    except ImportError:
        logger.error("yt-dlp is not installed. Run: pip install yt-dlp")
        update_job(job_id, status="failed", error="yt-dlp not installed")
        return

    output_dir = os.path.join(job_folder, "output")
    os.makedirs(output_dir, exist_ok=True)
    output_template = os.path.join(output_dir, "%(title)s.%(ext)s")

    last_pct = [0]

    def progress_hook(d):
        if is_cancelled(job_id):
            raise Exception("Job cancelled")
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            if total > 0:
                pct = min(int(85 * downloaded / total), 85)
                if pct > last_pct[0]:
                    last_pct[0] = pct
                    update_job(job_id, progress=pct)
        elif d.get("status") == "finished":
            logger.info(f"Download finished, post-processing...")
            update_job(job_id, status="post-processing", progress=90)

    ydl_opts = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "outtmpl": output_template,
        "progress_hooks": [progress_hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "merge_output_format": "mp4",
        "socket_timeout": 30,
        "retries": 3,
    }

    try:
        update_job(job_id, status="analyzing", progress=5)
        logger.info(f"Fetching info: {url}")
        append_log_event(job_folder, "phase", "Fetching video info")

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            title = info.get("title", "download")
            duration = info.get("duration", 0)
            logger.info(f"Title: {title} | Duration: {duration}s")
            update_job(job_id, title=title)

            if is_cancelled(job_id):
                update_job(job_id, status="cancelled")
                return

            update_job(job_id, status="recording", progress=10)
            logger.info("Starting download...")
            append_log_event(job_folder, "phase", "Downloading")

            ydl.download([url])

        # Find the output file
        output_file = None
        for f in os.listdir(output_dir):
            if not f.startswith("."):
                output_file = f
                break

        if not output_file:
            logger.error("No output file found after download")
            update_job(job_id, status="failed", error="Download produced no output file")
            return

        output_path = os.path.join(output_dir, output_file)

        # Generate thumbnail
        update_job(job_id, status="post-processing", progress=92)
        ext = os.path.splitext(output_file)[1].lower()
        if ext in (".mp4", ".webm", ".mkv", ".avi", ".mov"):
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
            output_file=output_file,
        )
        logger.info(f"yt-dlp download completed: {output_file}")
        append_log_event(job_folder, "completed", "Download finished")

    except Exception as e:
        err_msg = str(e)
        if "Job cancelled" in err_msg:
            update_job(job_id, status="cancelled")
            logger.info("Download cancelled by user")
            return

        # Retry with Playwright-exported cookies on auth/download errors
        if any(kw in err_msg.lower() for kw in ("403", "forbidden", "sign in", "bot", "empty", "reloaded")):
            logger.info("yt-dlp blocked — retrying with browser cookies...")
            append_log_event(job_folder, "phase", "Exporting browser cookies for retry")
            update_job(job_id, status="analyzing", progress=5)

            cookie_path = os.path.join(job_folder, "cookies.txt")
            if _export_cookies_via_playwright(url, cookie_path, logger):
                logger.info("Cookies exported, retrying download...")
                ydl_opts["cookiefile"] = cookie_path
                # Clear previous partial output
                for f in os.listdir(output_dir):
                    try:
                        os.remove(os.path.join(output_dir, f))
                    except Exception:
                        pass
                last_pct[0] = 0

                try:
                    update_job(job_id, status="recording", progress=10)
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl2:
                        ydl2.download([url])

                    output_file = None
                    for f in os.listdir(output_dir):
                        if not f.startswith("."):
                            output_file = f
                            break

                    if not output_file:
                        logger.error("Retry also produced no output file")
                        update_job(job_id, status="failed", error="Download failed even with browser cookies")
                        return

                    output_path = os.path.join(output_dir, output_file)
                    update_job(job_id, status="post-processing", progress=92)
                    ext = os.path.splitext(output_file)[1].lower()
                    if ext in (".mp4", ".webm", ".mkv", ".avi", ".mov"):
                        thumb_path = os.path.join(job_folder, "thumbnail.jpg")
                        cmd = build_thumbnail_command(output_path, thumb_path)
                        ok, _ = run_ffmpeg(cmd, logger=logger, timeout=30)
                        if ok:
                            update_job(job_id, thumbnail="thumbnail.jpg")

                    now = datetime.now(timezone.utc).isoformat()
                    update_job(job_id, status="completed", progress=100,
                               completed_at=now, output_file=output_file)
                    logger.info(f"yt-dlp download completed (with cookies): {output_file}")
                    append_log_event(job_folder, "completed", "Download finished")
                    return
                except Exception as e2:
                    logger.error(f"yt-dlp retry with cookies also failed: {e2}")
                    update_job(job_id, status="failed", error=str(e2)[:500])
                    return
            else:
                logger.error("Could not export browser cookies")

        logger.error(f"yt-dlp download failed: {err_msg}")
        update_job(job_id, status="failed", error=err_msg[:500])


# ---- Direct HTTP download ----

def _download_direct(job_id, url, job_folder, logger, cancel_flag):
    """Download a direct media URL via HTTP."""
    resolve_public_url(url)
    parsed = urllib.parse.urlparse(url)
    filename = os.path.basename(parsed.path) or "download.mp4"
    filename = re.sub(r'[^\w\-_.]', '_', filename)
    output_dir = os.path.join(job_folder, "output")
    os.makedirs(output_dir, exist_ok=True)

    update_job(job_id, status="recording", progress=10)

    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": urllib.parse.urljoin(url, "/"),
        })
        with safe_urlopen(req, context=ctx, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            if total > MAX_REMOTE_DOWNLOAD_BYTES:
                raise ValueError("Remote download exceeds the size limit")

            # Add extension from Content-Type if missing
            if not os.path.splitext(filename)[1]:
                ct = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
                ext_map = {
                    "video/mp4": ".mp4", "video/webm": ".webm",
                    "video/x-matroska": ".mkv", "audio/mpeg": ".mp3",
                }
                if ct in ext_map:
                    filename += ext_map[ct]

            output_path = os.path.join(output_dir, filename)
            downloaded = 0
            with open(output_path, "wb") as f:
                while True:
                    if is_cancelled(job_id):
                        update_job(job_id, status="cancelled")
                        logger.info("Download cancelled")
                        return
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > MAX_REMOTE_DOWNLOAD_BYTES:
                        raise ValueError("Remote download exceeded the size limit")
                    if total > 0:
                        pct = min(10 + int(80 * downloaded / total), 89)
                        update_job(job_id, progress=pct)
        logger.info(f"Downloaded {downloaded} bytes → {filename}")
    except Exception as e:
        logger.error(f"Download failed: {e}")
        update_job(job_id, status="failed", error=str(e))
        return

    # Post-processing
    update_job(job_id, status="post-processing", progress=90)

    ext = os.path.splitext(filename)[1].lower()
    if ext in (".mp4", ".webm", ".mkv", ".avi", ".mov"):
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
        output_file=filename,
    )
    logger.info(f"Direct download completed: {job_id}")
    append_log_event(job_folder, "completed", "Download finished")


# ---- Main entry point ----

def _download_tezfiles(job_id, url, job_folder, logger, cancel_flag):
    """Download video from TezFiles — tries DoodStream embed first, falls back to 360p preview."""
    from services.tezfiles_extractor import extract_tezfiles

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Extracting video from TezFiles: {url}")
    append_log_event(job_folder, "phase", "Analyzing TezFiles link")

    result = extract_tezfiles(url, timeout=60)
    if not result:
        logger.error("Could not extract video from TezFiles page")
        update_job(job_id, status="failed", error="Could not extract video from TezFiles page")
        return

    title = result.get("title", "")
    if title:
        update_job(job_id, title=title)

    if result["source"] == "doodstream" and result.get("embed_url"):
        # Full-quality path via DoodStream
        embed_url = result["embed_url"]
        logger.info(f"Found DoodStream embed → {embed_url}")
        append_log_event(job_folder, "phase", "Extracting full video via DoodStream")
        _download_via_playwright(job_id, embed_url, job_folder, logger, cancel_flag)
    elif result.get("stream_url"):
        # 360p preview from TezFiles
        logger.info(f"Using TezFiles 360p preview (limited quality)")
        append_log_event(job_folder, "phase", "Downloading 360p preview from TezFiles")
        _download_direct(job_id, result["stream_url"], job_folder, logger, cancel_flag)
    else:
        logger.error("TezFiles extraction returned no usable URL")
        update_job(job_id, status="failed", error="No video URL found on TezFiles page")


def _download_youtube(job_id, url, job_folder, logger, cancel_flag):
    """Download YouTube video via Playwright MSE interception + ffmpeg merge."""
    from services.youtube_extractor import download_youtube

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"YouTube URL → downloading via browser: {url}")
    append_log_event(job_folder, "phase", "Downloading YouTube via browser")

    output_dir = os.path.join(job_folder, "output")
    os.makedirs(output_dir, exist_ok=True)

    update_job(job_id, status="recording", progress=10)
    result = download_youtube(url, output_dir, logger=logger, timeout=180)

    if not result or not result.get("output_file"):
        # Fall back to yt-dlp (might work for non-SABR regions/videos)
        logger.info("Playwright download failed — falling back to yt-dlp")
        # Clean partial output
        for f in os.listdir(output_dir):
            try:
                os.remove(os.path.join(output_dir, f))
            except Exception:
                pass
        _download_with_ytdlp(job_id, url, job_folder, logger, cancel_flag)
        return

    title = result.get("title", "youtube_video")
    duration = result.get("duration", 0)
    output_file = result["output_file"]
    output_path = os.path.join(output_dir, output_file)

    update_job(job_id, title=title)

    # Thumbnail
    update_job(job_id, status="post-processing", progress=92)
    ext = os.path.splitext(output_file)[1].lower()
    if ext in (".mp4", ".webm", ".mkv"):
        thumb_path = os.path.join(job_folder, "thumbnail.jpg")
        thumb_cmd = build_thumbnail_command(output_path, thumb_path)
        thumb_ok, _ = run_ffmpeg(thumb_cmd, logger=logger, timeout=30)
        if thumb_ok:
            update_job(job_id, thumbnail="thumbnail.jpg")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_file,
    )
    logger.info(f"YouTube download completed: {output_file}")
    append_log_event(job_folder, "completed", "Download finished")


def _download_via_playwright(job_id, embed_url, job_folder, logger, cancel_flag):
    """Extract video URL from a CF-protected embed using Playwright, then download."""
    resolve_public_url(embed_url)
    from services.video_extractor import extract_video_url

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Extracting video URL from embed: {embed_url}")
    append_log_event(job_folder, "phase", "Extracting video URL via browser")

    video_url = extract_video_url(embed_url, timeout=60, retries=3)
    if not video_url:
        logger.error("Could not extract video URL from embed")
        update_job(job_id, status="failed", error="Could not extract video URL from embed page")
        return

    logger.info(f"Extracted video URL: {video_url[:150]}")
    update_job(job_id, progress=15)

    # Download the extracted URL directly
    _download_direct(job_id, video_url, job_folder, logger, cancel_flag)


def _download_pornhub(job_id, url, job_folder, logger, cancel_flag):
    """Download video from PornHub using Playwright + ffmpeg."""
    from services.pornhub_extractor import extract_pornhub

    update_job(job_id, status="analyzing", progress=5)
    logger.info(f"Extracting PornHub video: {url}")
    append_log_event(job_folder, "phase", "Analyzing PornHub page via browser")

    result = extract_pornhub(url, timeout=60)
    if not result or not result.get("video_url"):
        logger.error("Could not extract video URL from PornHub")
        update_job(job_id, status="failed", error="Could not extract video from PornHub page")
        return

    title = result.get("title", "pornhub_video")
    video_url = result["video_url"]
    cookies = result.get("cookies", "")
    referer = result.get("referer", url)

    update_job(job_id, title=title)
    logger.info(f"Video URL: {video_url[:150]}")
    logger.info(f"Title: {title}")

    # Sanitise filename
    safe_title = re.sub(r'[^\w\-_ ()]', '', title).strip() or "pornhub_video"
    safe_title = safe_title[:120]

    output_dir = os.path.join(job_folder, "output")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"{safe_title}.mp4")

    # Build ffmpeg command with cookies & referer headers
    headers = (
        f"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n"
        f"Referer: {referer}\r\n"
    )
    if cookies:
        headers += f"Cookie: {cookies}\r\n"

    cmd = [
        config.FFMPEG_PATH, "-y",
        "-headers", headers,
        "-i", video_url,
        "-c", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    update_job(job_id, status="recording", progress=10)
    logger.info("Downloading via ffmpeg...")
    append_log_event(job_folder, "phase", "Downloading video stream")

    def progress_cb(pct, info):
        # Scale to 10-89 range
        scaled = min(10 + int(pct * 0.79), 89)
        update_job(job_id, progress=scaled)

    # Try to get duration for progress tracking
    duration = None
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            duration = info.get("duration")
    except Exception:
        pass

    ok, stderr = run_ffmpeg(cmd, logger=logger, timeout=300,
                            progress_callback=progress_cb,
                            total_duration=duration)

    if not ok:
        logger.error(f"ffmpeg download failed")
        update_job(job_id, status="failed", error="ffmpeg download failed — see log for details")
        return

    # Verify output file exists and isn't empty
    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 1024:
        logger.error("Output file is missing or too small")
        update_job(job_id, status="failed", error="Download produced an empty or corrupt file")
        return

    output_file = os.path.basename(output_path)

    # Thumbnail
    update_job(job_id, status="post-processing", progress=92)
    thumb_path = os.path.join(job_folder, "thumbnail.jpg")
    thumb_cmd = build_thumbnail_command(output_path, thumb_path)
    thumb_ok, _ = run_ffmpeg(thumb_cmd, logger=logger, timeout=30)
    if thumb_ok:
        update_job(job_id, thumbnail="thumbnail.jpg")

    now = datetime.now(timezone.utc).isoformat()
    update_job(
        job_id,
        status="completed",
        progress=100,
        completed_at=now,
        output_file=output_file,
    )
    logger.info(f"PornHub download completed: {output_file}")
    append_log_event(job_folder, "completed", "Download finished")


def run_download_job(job_id, cancel_flag):
    job_folder = get_job_folder(job_id)
    logger = get_job_logger(job_id, job_folder)

    import json
    with open(os.path.join(job_folder, "metadata.json"), "r") as f:
        meta = json.load(f)
    params = meta.get("params", {})
    url = params.get("url", "")

    logger.info(f"Download job started: {url}")

    if not url:
        update_job(job_id, status="failed", error="No URL provided")
        return

    if _is_youtube_url(url):
        logger.info("YouTube URL → extracting via Playwright + ffmpeg")
        _download_youtube(job_id, url, job_folder, logger, cancel_flag)
    elif is_platform_url(url):
        logger.info("Detected platform URL → using yt-dlp")
        _download_with_ytdlp(job_id, url, job_folder, logger, cancel_flag)
    elif is_direct_url(url):
        logger.info("Direct media URL → HTTP download")
        _download_direct(job_id, url, job_folder, logger, cancel_flag)
    elif _is_tezfiles_url(url):
        logger.info("TezFiles URL → extracting via TezFiles extractor")
        _download_tezfiles(job_id, url, job_folder, logger, cancel_flag)
    elif _is_pornhub_url(url):
        logger.info("PornHub URL → extracting via Playwright + ffmpeg")
        _download_pornhub(job_id, url, job_folder, logger, cancel_flag)
    else:
        # Check if this is a video embed URL that needs Playwright extraction
        embed_hosts = [
            "dood", "do0od", "doodstream", "streamtape", "mixdrop", "upstream",
            "vidoza", "filemoon", "streamwish", "vidhide", "voe.sx", "vidguard",
        ]
        is_embed = any(h in url.lower() for h in embed_hosts)
        if is_embed:
            logger.info("Video embed URL → extracting with Playwright")
            _download_via_playwright(job_id, url, job_folder, logger, cancel_flag)
        else:
            # Try yt-dlp first — it supports hundreds of sites natively
            logger.info("Unknown URL type → trying yt-dlp first")
            try:
                import yt_dlp
                with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                    info = ydl.extract_info(url, download=False)
                    if info:
                        logger.info("yt-dlp can handle this URL")
                        _download_with_ytdlp(job_id, url, job_folder, logger, cancel_flag)
                        return
            except Exception as e:
                logger.info(f"yt-dlp cannot handle this URL: {e}")

            # Fallback: try to find an embed in the page HTML (e.g. YSF pages)
            from services.browse_session import _prefetch_embeds
            page_embeds, _title = _prefetch_embeds(url)
            if page_embeds:
                embed_url = page_embeds[0]
                logger.info(f"Found embed in page → {embed_url}")
                _download_via_playwright(job_id, embed_url, job_folder, logger, cancel_flag)
            else:
                logger.error("No supported download method found for this URL")
                update_job(job_id, status="failed",
                           error="Unsupported URL — not a direct media link, known platform, or embed page")
