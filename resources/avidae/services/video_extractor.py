"""Playwright-based video URL extractor for CF-protected embed sites (DoodStream, etc.)."""

import asyncio
import random
import string
import threading
import time

from utils.playwright_helper import create_browser_context, close_context_and_browser


def extract_video_url(embed_url, timeout=60, retries=2):
    """Navigate to an embed URL with Playwright and capture the actual video URL.

    Returns the direct video URL string, or None if extraction fails.
    Runs synchronously (blocks until done or timeout).
    """
    for attempt in range(retries):
        if attempt > 0:
            print(f"[VideoExtract] Retry {attempt}/{retries - 1}")
        result = [None]
        error = [None]

        def _run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                r = loop.run_until_complete(_extract(embed_url, timeout))
                result[0] = r
            except Exception as e:
                error[0] = str(e)
            finally:
                loop.close()

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        t.join(timeout=timeout + 10)
        if error[0]:
            print(f"[VideoExtract] Error: {error[0]}")
        if result[0]:
            return result[0]
    return None


async def _extract(embed_url, timeout):
    """Core async extraction logic."""
    from playwright.async_api import async_playwright

    video_url = None
    found = asyncio.Event()

    async with async_playwright() as pw:
        browser, ctx = await create_browser_context(pw, "1280x720")
        page = await ctx.new_page()

        # --- Block ad scripts that redirect the page away from DoodStream ---
        # DoodStream's ad JS navigates to landing.candynetwork.ai (and similar),
        # completely replacing the video player page.
        AD_BLOCK_PATTERNS = [
            "**/ads/ad.js",
            "**/ads/**",
            "**/*candynetwork*",
            "**/*candy.ai*",
            "**/*whireclogomod*",
            "**/ticdn.net/**",
            "**/*popunder*",
            "**/*popads*",
            "**/*landing.candy*",
        ]
        for pattern in AD_BLOCK_PATTERNS:
            await page.route(pattern, lambda route: route.abort())

        # --- Strategy 1: intercept media network requests ---
        def on_request(request):
            nonlocal video_url
            if found.is_set():
                return
            url = request.url
            rtype = request.resource_type
            if rtype == "media" or any(ext in url.lower() for ext in
                                       (".mp4", ".webm", ".m3u8")):
                if ".t.mp4" not in url and "thumb" not in url.lower():
                    video_url = url
                    print(f"[VideoExtract] media request → {url[:120]}")
                    found.set()

        page.on("request", on_request)

        # --- Strategy 2: monitor XHR/fetch responses for pass_md5 ---
        # The pass_md5 response body is a URL prefix.  We must call
        # response.finished() before reading to avoid the CDP race
        # where the body is GC'd.  Store raw URL for fallback.
        pass_md5_urls = []

        async def on_response(response):
            nonlocal video_url
            if found.is_set():
                return
            url = response.url
            if "pass_md5" not in url:
                return
            pass_md5_urls.append(url)
            try:
                await response.finished()
                body = await response.text()
                if body.startswith("http") and len(body) < 512:
                    token = "".join(random.choices(
                        string.ascii_lowercase + string.digits, k=10))
                    expiry = int(time.time() * 1000)
                    path_token = url.rstrip("/").rsplit("/", 1)[-1]
                    video_url = f"{body}{token}?token={path_token}&expiry={expiry}"
                    print(f"[VideoExtract] pass_md5 → {video_url[:120]}")
                    found.set()
            except Exception as e:
                print(f"[VideoExtract] pass_md5 body read failed: {e}")

        page.on("response", on_response)

        print(f"[VideoExtract] Navigating to {embed_url}")
        try:
            await page.goto(embed_url, wait_until="commit", timeout=30000)
        except Exception as e:
            print(f"[VideoExtract] Navigation warning: {e}")

        # Wait for Cloudflare challenge to clear (title changes from
        # "Just a moment..." to the real page title).
        for _ in range(20):
            try:
                title = await page.title()
                if "just a moment" not in title.lower():
                    break
            except Exception:
                pass
            await asyncio.sleep(1)

        # Ensure the page is fully loaded after CF clears
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass

        print(f"[VideoExtract] Page ready: {await page.title()}")

        # Wait for pass_md5 or media request (may arrive during page load)
        try:
            await asyncio.wait_for(found.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass

        # --- Fallback: if pass_md5 URL was seen but body read failed,
        # replay the request from the browser context (carries cookies) ---
        if not video_url and pass_md5_urls:
            print(f"[VideoExtract] Replaying pass_md5 from browser context...")
            for pm5_url in pass_md5_urls:
                try:
                    body = await page.evaluate("""(url) => {
                        return fetch(url, {credentials: 'include'})
                            .then(r => r.text())
                            .catch(() => '');
                    }""", pm5_url)
                    if body and body.startswith("http") and len(body) < 512:
                        token = "".join(random.choices(
                            string.ascii_lowercase + string.digits, k=10))
                        expiry = int(time.time() * 1000)
                        path_token = pm5_url.rstrip("/").rsplit("/", 1)[-1]
                        video_url = f"{body}{token}?token={path_token}&expiry={expiry}"
                        print(f"[VideoExtract] pass_md5 (replay) → {video_url[:120]}")
                        found.set()
                        break
                except Exception as e:
                    print(f"[VideoExtract] pass_md5 replay failed: {e}")

        # If nothing captured yet, try clicking play and waiting.
        # DoodStream often has ad overlays: first click opens an ad popup,
        # subsequent clicks actually hit the play button.
        if not video_url:
            # Track popups so we can close ad tabs
            popups = []

            def on_popup(popup_page):
                popups.append(popup_page)

            ctx.on("page", on_popup)

            vp = page.viewport_size
            cx, cy = vp["width"] // 2, vp["height"] // 2

            for click_num in range(4):
                if found.is_set():
                    break
                try:
                    print(f"[VideoExtract] Click {click_num + 1} at ({cx},{cy})...")
                    await page.mouse.click(cx, cy)
                    await asyncio.sleep(2)
                except Exception:
                    pass
                # Close any ad popups that opened
                for popup in popups:
                    try:
                        await popup.close()
                    except Exception:
                        pass
                popups.clear()

            try:
                await asyncio.wait_for(found.wait(), timeout=10)
            except asyncio.TimeoutError:
                pass

            # Replay fallback after clicks too
            if not video_url and pass_md5_urls:
                print(f"[VideoExtract] Replaying pass_md5 after clicks...")
                for pm5_url in pass_md5_urls:
                    try:
                        body = await page.evaluate("""(url) => {
                            return fetch(url, {credentials: 'include'})
                                .then(r => r.text())
                                .catch(() => '');
                        }""", pm5_url)
                        if body and body.startswith("http") and len(body) < 512:
                            token = "".join(random.choices(
                                string.ascii_lowercase + string.digits, k=10))
                            expiry = int(time.time() * 1000)
                            path_token = pm5_url.rstrip("/").rsplit("/", 1)[-1]
                            video_url = f"{body}{token}?token={path_token}&expiry={expiry}"
                            print(f"[VideoExtract] pass_md5 (replay) → {video_url[:120]}")
                            found.set()
                            break
                    except Exception:
                        pass

        # Strategy 3: check video DOM elements
        if not video_url:
            video_url = await page.evaluate("""() => {
                for (const v of document.querySelectorAll('video')) {
                    const src = v.currentSrc || v.src || '';
                    if (src && src.startsWith('http')) return src;
                    for (const s of v.querySelectorAll('source'))
                        if (s.src && s.src.startsWith('http')) return s.src;
                }
                return null;
            }""")
            if video_url:
                print(f"[VideoExtract] DOM video → {video_url[:120]}")

        if not video_url:
            print("[VideoExtract] No video URL found")

        await close_context_and_browser(ctx, browser)
        return video_url
