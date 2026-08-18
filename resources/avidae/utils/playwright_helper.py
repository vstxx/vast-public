import asyncio
import os
import sys
import config
from security import is_public_url, resolve_public_url


def _find_chrome_for_testing():
    """Locate Chrome for Testing binary installed by Playwright."""
    local_app = os.path.join(os.path.expanduser("~"), "AppData", "Local", "ms-playwright")
    if os.path.isdir(local_app):
        for d in sorted(os.listdir(local_app), reverse=True):
            if d.startswith("chromium-"):
                exe = os.path.join(local_app, d, "chrome-win64", "chrome.exe")
                if os.path.isfile(exe):
                    return exe
    return None


async def create_browser_context(playwright, resolution="1920x1080", headless=None,
                                  record_video_dir=None):
    if headless is None:
        headless = config.HEADLESS
    w, h = resolution.split("x")

    launch_kwargs = dict(
        headless=headless,
        args=[
            "--headless=new",
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--autoplay-policy=no-user-gesture-required",
            f"--window-size={w},{h}",
        ]
    )
    # Prefer Chrome for Testing (new headless mode) over the headless shell
    # to avoid Cloudflare and similar bot-detection challenges.
    chrome_path = _find_chrome_for_testing()
    if chrome_path:
        launch_kwargs["executable_path"] = chrome_path

    browser = await playwright.chromium.launch(**launch_kwargs)

    ctx_kwargs = dict(
        viewport={"width": int(w), "height": int(h)},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ignore_https_errors=False,
        java_script_enabled=True,
        locale="en-US",
    )

    # Use Playwright's native video recording if dir provided
    if record_video_dir:
        os.makedirs(record_video_dir, exist_ok=True)
        ctx_kwargs["record_video_dir"] = record_video_dir
        ctx_kwargs["record_video_size"] = {"width": int(w), "height": int(h)}

    context = await browser.new_context(**ctx_kwargs)

    async def guard_remote_request(route, request):
        if request.url.startswith(("data:", "blob:", "about:")):
            await route.continue_()
            return
        allowed = await asyncio.to_thread(is_public_url, request.url)
        if allowed:
            await route.continue_()
        else:
            await route.abort("blockedbyclient")

    await context.route("**/*", guard_remote_request)

    # Stealth: override navigator properties that Cloudflare and other
    # bot-detection services inspect before the page JS runs.
    await context.add_init_script("""
        // Hide webdriver flag
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Fake plugins array (headless has none by default)
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const arr = [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer',
                      description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                      description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin',
                      description: '' },
                ];
                arr.refresh = () => {};
                return arr;
            }
        });

        // Fake languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

        // Chrome runtime stub
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

        // Permissions API — hide "denied" notification state
        const origQuery = window.Permissions?.prototype?.query;
        if (origQuery) {
            window.Permissions.prototype.query = function(params) {
                if (params?.name === 'notifications')
                    return Promise.resolve({ state: 'prompt', onchange: null });
                return origQuery.call(this, params);
            };
        }
    """)

    return browser, context


async def navigate_and_prepare(page, url, play_selector=None, video_selector=None,
                               delay=3, logger=None):
    await asyncio.to_thread(resolve_public_url, url)
    if logger:
        logger.info(f"Navigating to: {url}")

    await page.goto(url, wait_until="commit", timeout=60000)

    if logger:
        logger.info("Response committed, waiting for content...")

    try:
        await page.wait_for_selector("body :first-child", timeout=15000)
    except Exception:
        if logger:
            logger.warning("Timeout waiting for body content")

    try:
        await page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        if logger:
            logger.warning("Network idle timeout, continuing...")

    if play_selector:
        if logger:
            logger.info(f"Clicking play button: {play_selector}")
        try:
            await page.wait_for_selector(play_selector, timeout=10000)
            await page.click(play_selector)
            if logger:
                logger.info("Play button clicked")
        except Exception as e:
            if logger:
                logger.warning(f"Could not click play button: {e}")

    if video_selector:
        if logger:
            logger.info(f"Waiting for video element: {video_selector}")
        try:
            await page.wait_for_selector(video_selector, timeout=10000)
        except Exception as e:
            if logger:
                logger.warning(f"Video element not found: {e}")

    if delay > 0:
        if logger:
            logger.info(f"Waiting {delay}s before recording...")
        await asyncio.sleep(delay)

    if logger:
        logger.info("Page ready for recording")


async def take_screenshot(page, path):
    await page.screenshot(path=path, full_page=False)


async def take_preview_screenshot(page, path, quality=50):
    """Take a low-quality JPEG screenshot for live preview."""
    try:
        await page.screenshot(path=path, type="jpeg", quality=quality)
        return True
    except Exception:
        return False


async def close_context_and_browser(context, browser, logger=None):
    """Close context (finalizes video) then browser."""
    try:
        await context.close()
    except Exception as e:
        if logger:
            logger.warning(f"Error closing context: {e}")
    try:
        await browser.close()
    except Exception as e:
        if logger:
            logger.warning(f"Error closing browser: {e}")


async def close_browser(browser, logger=None):
    try:
        await browser.close()
    except Exception as e:
        if logger:
            logger.warning(f"Error closing browser: {e}")


def analyze_page_sync(url):
    """Quick synchronous analysis of a URL to detect video elements."""
    return asyncio.run(_analyze_page(url))


async def _analyze_page(url):
    from playwright.async_api import async_playwright
    result = {
        "url": url,
        "title": "",
        "has_video": False,
        "video_elements": [],
        "iframes": [],
        "play_buttons": [],
    }
    try:
        async with async_playwright() as pw:
            browser, context = await create_browser_context(pw)
            page = await context.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass

            result["title"] = await page.title()

            videos = await page.query_selector_all("video")
            for i, v in enumerate(videos):
                src = await v.get_attribute("src") or ""
                result["video_elements"].append({"index": i, "src": src})
            result["has_video"] = len(videos) > 0

            iframes = await page.query_selector_all("iframe")
            for iframe in iframes:
                src = await iframe.get_attribute("src") or ""
                if src:
                    result["iframes"].append(src)

            selectors = [
                "button[aria-label*='play' i]",
                "button[aria-label*='Play' i]",
                "[class*='play-button']",
                "[class*='playButton']",
                ".ytp-play-button",
                ".vjs-play-control",
            ]
            for sel in selectors:
                try:
                    els = await page.query_selector_all(sel)
                    if els:
                        result["play_buttons"].append(sel)
                except Exception:
                    pass

            await close_context_and_browser(context, browser)
    except Exception as e:
        result["error"] = str(e)
    return result
