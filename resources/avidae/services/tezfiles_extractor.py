"""TezFiles video extractor — extracts stream URLs from tezfiles.com file pages.

Strategy:
1. Get file metadata from TezFiles API (title, source site, file ID).
2. Search the source site for a page with a DoodStream embed.
3. If DoodStream found → return embed URL (caller uses video_extractor for 1080p).
4. Otherwise → click PlayVideo on TezFiles to get the 360p preview stream URL.
"""

import asyncio
import re
import threading

from utils.playwright_helper import create_browser_context, close_context_and_browser


# Hosts that carry full-quality video embeds (DoodStream, etc.)
_EMBED_HOSTS = [
    "dood", "do0od", "doodstream", "streamtape", "mixdrop", "upstream",
    "vidoza", "filemoon", "streamwish", "vidhide", "voe.sx", "vidguard",
]


def is_tezfiles_url(url):
    """Check if URL is a TezFiles file page."""
    return bool(re.match(r"https?://(?:www\.)?tezfiles\.com/file/", url))


def extract_tezfiles(url, timeout=60):
    """Extract video info from a TezFiles URL.

    Returns dict with keys:
        stream_url   — direct video URL (360p preview OR full DoodStream)
        title        — video title
        source       — "doodstream" | "tezfiles_preview"
        embed_url    — DoodStream embed URL if found, else None
    Or None on failure.
    """
    result = [None]
    error = [None]

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result[0] = loop.run_until_complete(_extract_tezfiles(url, timeout))
        except Exception as e:
            error[0] = str(e)
        finally:
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=timeout + 10)
    if error[0]:
        print(f"[TezFiles] Error: {error[0]}")
    return result[0]


def _parse_file_id(url):
    """Extract file ID from tezfiles.com/file/{id}."""
    m = re.search(r"tezfiles\.com/file/([a-zA-Z0-9]+)", url)
    return m.group(1) if m else None


async def _extract_tezfiles(url, timeout):
    from playwright.async_api import async_playwright

    file_id = _parse_file_id(url)
    if not file_id:
        print(f"[TezFiles] Cannot parse file ID from {url}")
        return None

    async with async_playwright() as pw:
        browser, ctx = await create_browser_context(pw)
        page = await ctx.new_page()

        # --- Step 1: Load TezFiles page and get metadata via API ---
        print(f"[TezFiles] Loading {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(2000)

        title = ""
        source_site = ""

        # Get file info from API (using browser's auth cookie)
        try:
            file_info = await page.evaluate("""async (fileId) => {
                try {
                    // Get anonymous token
                    const tResp = await fetch("https://api.tezfiles.com/v1/auth/token",
                        {method: "POST", credentials: "include"});
                    const tData = await tResp.json();
                    const token = tData.access_token;
                    if (!token) return null;

                    // Get file info
                    const fResp = await fetch(
                        `https://api.tezfiles.com/v1/files/${fileId}?referer=`,
                        {headers: {"Authorization": "Bearer " + token}});
                    const fData = await fResp.json();

                    // Get source site
                    let site = "";
                    try {
                        const sResp = await fetch(
                            `https://api.tezfiles.com/v1/files/${fileId}/site?referer=`,
                            {headers: {"Authorization": "Bearer " + token}});
                        const sData = await sResp.json();
                        site = sData.hostname || "";
                    } catch(e) {}

                    return {
                        name: fData.name || "",
                        size: fData.size || 0,
                        duration: fData.videoInfo?.duration || 0,
                        width: fData.videoInfo?.resolution?.width || 0,
                        height: fData.videoInfo?.resolution?.height || 0,
                        site: site
                    };
                } catch(e) { return null; }
            }""", file_id)
        except Exception as e:
            print(f"[TezFiles] API call failed: {e}")
            file_info = None

        if file_info:
            title = file_info.get("name", "")
            source_site = file_info.get("site", "")
            dur = file_info.get("duration", 0)
            w = file_info.get("width", 0)
            h = file_info.get("height", 0)
            print(f"[TezFiles] Title: {title}")
            print(f"[TezFiles] Source: {source_site} | {dur:.0f}s | {w}x{h}")

        if not title:
            # Fallback: get title from page
            page_title = await page.title()
            title = re.sub(r"^TezFiles\s*[-–]\s*", "", page_title).strip()
            print(f"[TezFiles] Title (from page): {title}")

        # Also try to get site from URL params
        if not source_site:
            m = re.search(r"[?&]site=([^&]+)", url)
            if m:
                import urllib.parse
                source_site = urllib.parse.unquote(m.group(1))
                source_site = re.sub(r"^https?://", "", source_site).rstrip("/")
                print(f"[TezFiles] Source site (from URL): {source_site}")

        # --- Step 2: Search source site for DoodStream embed ---
        embed_url = None
        if source_site:
            embed_url = await _find_embed_on_source(page, title, source_site)

        if embed_url:
            print(f"[TezFiles] Found DoodStream embed: {embed_url}")
            await close_context_and_browser(ctx, browser)
            return {
                "stream_url": None,
                "title": re.sub(r"\.\w{3,4}$", "", title),
                "source": "doodstream",
                "embed_url": embed_url,
            }

        # --- Step 3: Get 360p preview stream from TezFiles player ---
        print("[TezFiles] No embed found, getting 360p preview...")

        # Navigate back to TezFiles page if we left
        current = page.url
        if "tezfiles.com" not in current:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2000)

        stream_url = None

        def on_media_request(req):
            nonlocal stream_url
            if req.resource_type == "media" and not stream_url:
                stream_url = req.url
                print(f"[TezFiles] Stream: {req.url[:120]}")

        page.on("request", on_media_request)

        # Click PlayVideo overlay
        try:
            await page.evaluate(
                'document.querySelector("[data-testid=PlayVideo]")?.click()')
            await page.wait_for_timeout(5000)
        except Exception:
            pass

        # Also try getting src from video element
        if not stream_url:
            stream_url = await page.evaluate("""() => {
                const v = document.querySelector("video");
                return v?.src || v?.currentSrc || null;
            }""")

        await close_context_and_browser(ctx, browser)

        if stream_url:
            return {
                "stream_url": stream_url,
                "title": re.sub(r"\.\w{3,4}$", "", title),
                "source": "tezfiles_preview",
                "embed_url": None,
            }

        print("[TezFiles] Failed to extract any video URL")
        return None


async def _find_embed_on_source(page, title, source_site):
    """Search source site for a video page with a DoodStream embed."""
    # Clean title for search
    clean = re.sub(r"\.\w{3,4}$", "", title)  # remove extension
    clean = re.sub(r"[#_\-]+", " ", clean).strip()

    search_url = f"https://{source_site}/?s={clean.replace(' ', '+')}"
    print(f"[TezFiles] Searching source: {search_url}")

    try:
        await page.goto(search_url, wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(2000)
    except Exception as e:
        print(f"[TezFiles] Source search failed: {e}")
        return None

    # Find video page links in search results
    results = await page.evaluate("""(titleLower) => {
        const articles = document.querySelectorAll(
            "article a, .post a, .video-item a, .thumb a, h2 a, h3 a, .entry-title a");
        const seen = new Set();
        const out = [];
        for (const a of articles) {
            const href = a.href;
            const text = (a.textContent || "").trim();
            if (!href || seen.has(href)) continue;
            seen.add(href);
            // Match by checking if link text contains significant words from the title
            const words = titleLower.split(/\\s+/).filter(w => w.length > 3);
            const matchCount = words.filter(w => text.toLowerCase().includes(w)).length;
            if (matchCount >= Math.min(3, words.length)) {
                out.push({href, text: text.substring(0, 120), score: matchCount});
            }
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, 5);
    }""", clean.lower())

    if not results:
        print("[TezFiles] No matching video pages found on source site")
        return None

    print(f"[TezFiles] Found {len(results)} candidate pages")

    # Check each candidate for a DoodStream embed
    hosts_pat = "|".join(re.escape(h) for h in _EMBED_HOSTS)
    embed_re = re.compile(
        r'(?:src|data-src)\s*=\s*["\']'
        r'(https?://[^"\']*?(?:' + hosts_pat + r')[^"\']*?)["\']',
        re.IGNORECASE,
    )

    for r in results:
        video_page = r["href"]
        print(f"[TezFiles] Checking: {video_page[:100]}")
        try:
            await page.goto(video_page, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(2000)
            content = await page.content()

            matches = embed_re.findall(content)
            if matches:
                return matches[0]
        except Exception as e:
            print(f"[TezFiles] Page check failed: {e}")
            continue

    return None
