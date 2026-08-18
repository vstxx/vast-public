"""Playwright-based PornHub video extractor.

PornHub blocks yt-dlp's HTTP client (HLS segments return 404 without
a real browser session).  This module navigates the page with Playwright,
captures the HLS master m3u8 URL (or direct .mp4) along with cookies,
so ffmpeg can download the stream with the correct credentials.
"""

import asyncio
import re
import threading

from utils.playwright_helper import create_browser_context, close_context_and_browser


def is_pornhub_url(url):
    """Return True if *url* looks like a PornHub video page."""
    return bool(re.match(
        r"https?://(?:\w+\.)?pornhub\.com/view_video\.php", url, re.I
    ))


def extract_pornhub(url, timeout=60):
    """Extract video info from a PornHub page using a real browser.

    Returns a dict on success::

        {
            "title": str,
            "video_url": str,       # m3u8 master or direct .mp4
            "cookies": str,         # "k1=v1; k2=v2" for HTTP headers
            "referer": str,         # page URL
        }

    Returns ``None`` on failure.
    """
    result = [None]
    error = [None]

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result[0] = loop.run_until_complete(_extract(url, timeout))
        except Exception as exc:
            error[0] = str(exc)
        finally:
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout + 15)

    if error[0]:
        print(f"[PornHub] Extraction error: {error[0]}")
    return result[0]


async def _extract(url, timeout):
    from playwright.async_api import async_playwright

    video_url = None
    found = asyncio.Event()
    captured = {}  # store best quality m3u8

    # Ad / tracking domains to ignore when capturing media requests
    AD_DOMAINS = (
        "adtng.com", "adsco.re", "ads.trafficjunky", "trafficjunky.com",
        "cdn77.org/tags", "syndication", "tracking", "analytic",
    )

    async with async_playwright() as pw:
        browser, ctx = await create_browser_context(pw, "1280x720")
        page = await ctx.new_page()

        # --- Intercept network requests for HLS / mp4 ---
        def on_request(request):
            nonlocal video_url
            if found.is_set():
                return
            req_url = request.url
            # Skip ad domains
            if any(ad in req_url for ad in AD_DOMAINS):
                return
            # Capture m3u8 from pornhub CDN
            if ".m3u8" in req_url and "pornhub" in req_url:
                captured["master"] = req_url
                print(f"[PornHub] m3u8 request -> {req_url[:150]}")

        page.on("request", on_request)

        print(f"[PornHub] Navigating to {url}")
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            print(f"[PornHub] Navigation warning: {exc}")

        # Wait for page to settle
        try:
            await page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass

        # Give some time for the HLS player to start
        await asyncio.sleep(3)

        # --- Strategy 1: Extract from flashvars / page JS ---
        video_url = await page.evaluate("""() => {
            // PornHub stores quality URLs in flashvars_* objects
            for (const key of Object.keys(window)) {
                if (key.startsWith('flashvars_')) {
                    const fv = window[key];
                    // mediaDefinitions array — best approach
                    if (fv.mediaDefinitions) {
                        // Prefer HLS master (gives all qualities to ffmpeg)
                        const hls = fv.mediaDefinitions
                            .filter(d => d.videoUrl && d.format === 'hls');
                        if (hls.length) return hls[0].videoUrl;
                        // Fall back to highest quality mp4
                        const defs = fv.mediaDefinitions
                            .filter(d => d.videoUrl && d.format === 'mp4')
                            .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
                        if (defs.length) return defs[0].videoUrl;
                    }
                    // Legacy quality_XYZp keys
                    for (const q of ['quality_1080p', 'quality_720p', 'quality_480p', 'quality_240p']) {
                        if (fv[q]) return fv[q];
                    }
                }
            }
            // Fallback: video element src
            const v = document.querySelector('video');
            if (v) {
                const src = v.currentSrc || v.src || '';
                if (src.startsWith('http')) return src;
                for (const s of v.querySelectorAll('source')) {
                    if (s.src && s.src.startsWith('http')) return s.src;
                }
            }
            return null;
        }""")
        if video_url:
            print(f"[PornHub] JS extraction -> {video_url[:150]}")

        # If JS returned a JSON array URL (mediaDefinitions sometimes returns
        # a URL that serves a JSON list of quality options), follow it
        if video_url and "/hls/master" not in video_url and video_url.endswith(".m3u8"):
            pass  # already an m3u8, good
        elif video_url and "media=hls" in video_url:
            # This is an intermediate URL that returns the actual m3u8
            try:
                actual = await page.evaluate("""(url) => {
                    return fetch(url).then(r => r.json()).then(data => {
                        if (Array.isArray(data)) {
                            const best = data.sort((a,b) => (parseInt(b.quality)||0) - (parseInt(a.quality)||0));
                            return best[0]?.videoUrl || null;
                        }
                        return null;
                    }).catch(() => null);
                }""", video_url)
                if actual:
                    print(f"[PornHub] Resolved media URL -> {actual[:150]}")
                    video_url = actual
            except Exception:
                pass

        # If we found an m3u8 from network but no JS result, use it
        if not video_url and captured.get("master"):
            video_url = captured["master"]

        # --- Strategy 2: If still nothing, try clicking the play button ---
        if not video_url:
            print("[PornHub] No video URL yet, clicking play area...")
            try:
                play_btn = page.locator(".videoElementPoster, .playButton, .video-wrapper, #player")
                if await play_btn.count() > 0:
                    await play_btn.first.click()
                else:
                    vp = page.viewport_size
                    await page.mouse.click(vp["width"] // 2, vp["height"] // 2)
                await asyncio.sleep(5)
            except Exception:
                pass

            # Re-check JS
            video_url = await page.evaluate("""() => {
                const v = document.querySelector('video');
                if (v) {
                    const src = v.currentSrc || v.src || '';
                    if (src.startsWith('http')) return src;
                }
                return null;
            }""")
            if video_url:
                print(f"[PornHub] After click -> {video_url[:150]}")

        if not video_url and captured.get("master"):
            video_url = captured["master"]

        if not video_url:
            print("[PornHub] No video URL found")
            await close_context_and_browser(ctx, browser)
            return None

        # --- Collect title ---
        title = await page.evaluate("""() => {
            const el = document.querySelector('h1.title span.inlineFree, h1.title, .video-wrapper h1');
            return el ? el.textContent.trim() : document.title;
        }""")

        # --- Collect cookies ---
        cookies = await ctx.cookies()
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)

        await close_context_and_browser(ctx, browser)

        return {
            "title": title or "",
            "video_url": video_url,
            "cookies": cookie_str,
            "referer": url,
        }
