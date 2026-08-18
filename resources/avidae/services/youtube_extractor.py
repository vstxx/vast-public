"""Playwright-based YouTube video downloader.

yt-dlp is blocked by YouTube with HTTP 403 (SABR streaming / PO token).
This module uses a real browser (Playwright + Chrome for Testing) to:
1. Navigate to the YouTube video page
2. Intercept decoded media segments from the MSE SourceBuffer
3. Save the raw video + audio streams to disk
4. Merge them with ffmpeg into a single .mp4 file

The intercepted data is the *decoded* SABR output — raw H.264/AV1 + AAC/Opus
segments — so the download preserves the original quality the browser received.
"""

import asyncio
import os
import re
import threading

from utils.playwright_helper import create_browser_context, close_context_and_browser


def is_youtube_url(url):
    """Return True if *url* is a YouTube video / shorts page."""
    return bool(re.match(
        r"https?://(?:www\.|m\.|music\.)?(?:youtube\.com/(?:watch|shorts/)|youtu\.be/)",
        url, re.I,
    ))


# ---- MSE init script (injected before page JS) --------------------------

_MSE_INTERCEPT_SCRIPT = """
window.__yt_sb_data = {};

const _origAddSB = MediaSource.prototype.addSourceBuffer;
MediaSource.prototype.addSourceBuffer = function(mimeType) {
    const sb = _origAddSB.call(this, mimeType);
    const baseType = mimeType.split(';')[0].trim();
    if (!window.__yt_sb_data[baseType]) {
        window.__yt_sb_data[baseType] = {
            mime: mimeType, chunks: [], totalSize: 0
        };
    }
    const store = window.__yt_sb_data[baseType];

    const _origAppend = sb.appendBuffer.bind(sb);
    sb.appendBuffer = function(data) {
        try {
            const buf = (data instanceof ArrayBuffer)
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            store.chunks.push(buf.slice());
            store.totalSize += buf.byteLength;
        } catch(e) {}
        return _origAppend(data);
    };
    return sb;
};
"""


def download_youtube(url, output_dir, logger=None, timeout=120):
    """Download a YouTube video into *output_dir* using a real browser.

    Returns a dict on success::

        {
            "title":       str,
            "output_file": str,      # filename inside output_dir
            "duration":    int,
        }

    Returns ``None`` on failure.
    """
    result = [None]
    error = [None]

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result[0] = loop.run_until_complete(
                _download(url, output_dir, logger, timeout)
            )
        except Exception as exc:
            error[0] = str(exc)
        finally:
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout + 30)

    if error[0]:
        _log(logger, f"[YouTube] Error: {error[0]}")
    return result[0]


def _log(logger, msg):
    if logger:
        logger.info(msg)
    else:
        print(msg)


# ---- Core async download ------------------------------------------------

async def _download(url, output_dir, logger, timeout):
    import config
    from utils.ffmpeg_helper import run_ffmpeg
    from playwright.async_api import async_playwright

    os.makedirs(output_dir, exist_ok=True)

    async with async_playwright() as pw:
        browser, ctx = await create_browser_context(pw, "1280x720")

        # Inject MSE interceptor *before* any page JS runs
        await ctx.add_init_script(_MSE_INTERCEPT_SCRIPT)

        page = await ctx.new_page()

        # ---- Navigate ----
        _log(logger, f"[YouTube] Navigating to {url}")
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            _log(logger, f"[YouTube] Nav warning: {e}")

        # Dismiss cookie consent (EU)
        await _dismiss_consent(page)

        try:
            await page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass

        await asyncio.sleep(2)

        # ---- Extract title & duration ----
        info = await page.evaluate("""() => {
            const pr = window.ytInitialPlayerResponse
                    || (document.getElementById('movie_player')
                        ?.getPlayerResponse?.());
            if (!pr) return {};
            const vd = pr.videoDetails || {};
            return { t: vd.title || '', d: parseInt(vd.lengthSeconds || '0') };
        }""")
        title = info.get("t", "") or "youtube_video"
        duration = info.get("d", 0)
        _log(logger, f"[YouTube] Title: {title} | Duration: {duration}s")

        # ---- Start playback & request best quality ----
        await page.evaluate("""() => {
            const p = document.getElementById('movie_player');
            if (p) {
                try { p.playVideo(); } catch(e) {}
                try { p.setPlaybackQualityRange('hd1080', 'hd2160'); } catch(e) {}
                try { p.setPlaybackQuality('hd1080'); } catch(e) {}
            }
            const v = document.querySelector('video');
            if (v) { try { v.play(); } catch(e) {} }
        }""")

        # ---- Wait for full buffer ----
        _log(logger, "[YouTube] Waiting for video to buffer...")
        max_wait = min(duration * 3 + 30, timeout - 20) if duration > 0 else timeout - 20
        for i in range(int(max_wait)):
            status = await page.evaluate("""() => {
                const v = document.querySelector('video');
                let buffered = 0, dur = 0;
                if (v) {
                    dur = v.duration || 0;
                    if (v.buffered.length > 0)
                        buffered = v.buffered.end(v.buffered.length - 1);
                }
                let totalSB = 0;
                for (const d of Object.values(window.__yt_sb_data || {}))
                    totalSB += d.totalSize;
                return { buffered, dur, totalSB, ready: v ? v.readyState : -1 };
            }""")
            buf = status.get("buffered", 0)
            dur = status.get("dur", 0)
            sb_size = status.get("totalSB", 0)

            if i % 5 == 0:
                _log(logger, f"[YouTube]   buffered={buf:.1f}/{dur:.1f}s  "
                             f"data={sb_size // 1024}KB")

            if dur > 0 and buf >= dur - 0.5:
                _log(logger, "[YouTube] Fully buffered!")
                break
            await asyncio.sleep(1)
        else:
            _log(logger, "[YouTube] Buffer wait timed out — saving what we have")

        # ---- Check captured data ----
        sb_info = await page.evaluate("""() => {
            const r = {};
            for (const [k, v] of Object.entries(window.__yt_sb_data || {}))
                r[k] = { mime: v.mime, chunks: v.chunks.length, totalSize: v.totalSize };
            return r;
        }""")

        if not sb_info:
            _log(logger, "[YouTube] No MSE data captured")
            await close_context_and_browser(ctx, browser)
            return None

        for k, v in sb_info.items():
            _log(logger, f"[YouTube] Captured {k}: {v['chunks']} chunks, "
                         f"{v['totalSize'] // 1024}KB ({v['mime']})")

        # ---- Save streams via Playwright download ----
        saved_files = {}
        for mime_key in sb_info:
            kind = "video" if "video" in mime_key else "audio"
            ext = "mp4" if "mp4" in mime_key else "webm"
            fname = f"_yt_{kind}.{ext}"
            fpath = os.path.join(output_dir, fname)

            try:
                async with page.expect_download(timeout=60000) as dl_info:
                    await page.evaluate("""(key) => {
                        const data = window.__yt_sb_data[key];
                        const blob = new Blob(data.chunks);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'stream.bin';
                        document.body.appendChild(a);
                        a.click();
                        URL.revokeObjectURL(url);
                    }""", mime_key)
                download = await dl_info.value
                await download.save_as(fpath)
                saved_files[kind] = fpath
                _log(logger, f"[YouTube] Saved {kind} -> {fpath} "
                             f"({os.path.getsize(fpath)} bytes)")
            except Exception as e:
                _log(logger, f"[YouTube] Failed to save {kind}: {e}")

        await close_context_and_browser(ctx, browser)

    if "video" not in saved_files:
        _log(logger, "[YouTube] No video stream saved")
        return None

    # ---- Merge with ffmpeg ----
    safe_title = re.sub(r'[^\w\-_ ()]', '', title).strip() or "youtube_video"
    safe_title = safe_title[:120]
    output_path = os.path.join(output_dir, f"{safe_title}.mp4")

    video_path = saved_files["video"]
    audio_path = saved_files.get("audio")

    if audio_path:
        audio_ext = os.path.splitext(audio_path)[1].lower()
        a_codec = "aac" if audio_ext == ".webm" else "copy"

        cmd = [
            config.FFMPEG_PATH, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", a_codec,
            "-movflags", "+faststart",
            output_path,
        ]
    else:
        cmd = [
            config.FFMPEG_PATH, "-y",
            "-i", video_path,
            "-c", "copy",
            "-movflags", "+faststart",
            output_path,
        ]

    _log(logger, "[YouTube] Merging streams with ffmpeg...")
    ok, stderr = run_ffmpeg(cmd, logger=logger, timeout=120)

    # Clean up temp stream files
    for f in saved_files.values():
        try:
            os.remove(f)
        except Exception:
            pass

    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 1024:
        _log(logger, "[YouTube] Merge failed or output too small")
        return None

    _log(logger, f"[YouTube] Done: {safe_title}.mp4 "
                 f"({os.path.getsize(output_path) // 1024}KB)")
    return {
        "title": title,
        "output_file": f"{safe_title}.mp4",
        "duration": duration,
    }


# ---- Helpers -------------------------------------------------------------

async def _dismiss_consent(page):
    try:
        for sel in (
            'button[aria-label*="Accept"]',
            'button:has-text("Accept all")',
            'button:has-text("Reject all")',
            'tp-yt-paper-button:has-text("Reject")',
        ):
            btn = page.locator(sel)
            if await btn.count() > 0:
                await btn.first.click()
                await asyncio.sleep(2)
                return
    except Exception:
        pass
