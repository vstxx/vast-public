"""Browse session manager — opens URLs in headless Playwright with auto video detection and recording."""

import os
import asyncio
import time
import json
import threading
import base64
import shutil
import glob
from urllib.parse import urlparse
from datetime import datetime, timezone

import config
from utils.playwright_helper import create_browser_context, close_context_and_browser
from utils.ffmpeg_helper import run_ffmpeg, build_thumbnail_command
from security import safe_urlopen

# Injected into every page to detect <video> play/pause/ended events
# and iframe embeds from known video hosts
_EMBED_HOSTS = [
    "dood", "do0od", "doodstream", "streamtape", "mixdrop", "upstream",
    "vidoza", "filemoon", "streamwish", "vidhide", "voe.sx", "vidguard",
]

_ADBLOCK_HOST_KEYWORDS = [
    "doubleclick.net", "googlesyndication.com", "google-analytics.com",
    "googletagmanager.com", "googleadservices.com", "adservice.google.",
    "adnxs.com", "adsystem.com", "adsrvr.org", "pubmatic.com",
    "rubiconproject.com", "openx.net", "criteo.com", "taboola.com",
    "outbrain.com", "mgid.com", "popads.net", "popcash.net",
    "propellerads.com", "propellerclick.com", "onclickads.net",
    "exoclick.com", "exosrv.com", "juicyads.com", "trafficjunky.net",
    "trafficstars.com", "ero-advertising.com", "adnium.com",
    "hilltopads.net", "clickadu.com", "realsrv.com", "adskeeper.com",
    "histats.com", "statcounter.com", "hotjar.com", "clarity.ms",
]

_ADBLOCK_URL_KEYWORDS = [
    "/ads/", "/adserver/", "/adserve/", "/banner/", "/banners/",
    "/popunder", "/popup", "/preroll", "/vast?", "/vmap?",
    "ad_banner", "adzone", "ad-unit", "ad_unit", "tracking_pixel",
]


def _is_ad_request(url, resource_type):
    """Conservative request blocker for the embedded browser."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    host = (parsed.hostname or "").lower()
    full = url.lower()

    if any(embed_host in host for embed_host in _EMBED_HOSTS):
        return False

    if any(keyword in host for keyword in _ADBLOCK_HOST_KEYWORDS):
        return True

    if resource_type in ("script", "image", "xhr", "fetch", "stylesheet", "font", "other"):
        return any(keyword in full for keyword in _ADBLOCK_URL_KEYWORDS)

    return False


def _prefetch_embeds(url):
    """Quick HTTP fetch to scan raw HTML for embed iframes.

    Works even when Cloudflare blocks headless browsers because the
    raw HTML response often still contains the embed before any JS
    challenge intervenes.  Returns (list_of_embed_URLs, title_or_empty).
    """
    import re
    import ssl
    import urllib.request

    urls_to_try = [url]

    # YSF special handling: /video/{id}/{slug} serves homepage;
    # the canonical /{slug}/ URL serves actual content.
    m = re.match(r'(https?://yoursmokingfetish\.com)/video/\d+/([^/?#]+)', url)
    if m:
        canonical = f"{m.group(1)}/{m.group(2)}/"
        urls_to_try.insert(0, canonical)

    for try_url in urls_to_try:
        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(try_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            })
            with safe_urlopen(req, context=ctx, timeout=12) as resp:
                body = resp.read(512_000).decode("utf-8", errors="ignore")
            hosts_pat = "|".join(re.escape(h) for h in _EMBED_HOSTS)
            embeds = []
            for em in re.finditer(
                r'(?:src|data-src)\s*=\s*["\']'
                r'(https?://[^"\']*?(?:' + hosts_pat + r')[^"\']*?)["\']',
                body, re.IGNORECASE
            ):
                u = em.group(1)
                if u not in embeds:
                    embeds.append(u)
            title = ""
            tm = re.search(r'<title[^>]*>([^<]+)</title>', body, re.IGNORECASE)
            if tm:
                title = tm.group(1).strip()
            if embeds:
                return embeds, title
        except Exception:
            continue
    return [], ""

_DETECTOR_JS = """() => {
    if (window.__vd) return;
    window.__vd = true;
    const rpt = (t, d) => {
        if (window.__vdCb) window.__vdCb(JSON.stringify({type:t,...d}));
    };
    const watch = (v, i) => {
        if (v.__vdW) return;
        v.__vdW = true;
        const nfo = () => ({
            i, src: v.currentSrc||v.src||'',
            dur: isNaN(v.duration)?0:v.duration,
            ct: v.currentTime, paused: v.paused
        });
        v.addEventListener('playing', () => rpt('playing', nfo()));
        v.addEventListener('pause', () => rpt('pause', nfo()));
        v.addEventListener('ended', () => rpt('ended', nfo()));
        v.addEventListener('loadedmetadata', () => rpt('meta', nfo()));
        if (!v.paused && v.currentTime > 0) rpt('playing', nfo());
        if (v.readyState >= 1 && v.duration > 0) rpt('meta', nfo());
    };
    document.querySelectorAll('video').forEach(watch);
    new MutationObserver(() => document.querySelectorAll('video').forEach(watch))
        .observe(document.documentElement, {childList:true, subtree:true});
    // Scan iframes for video embeds
    const embedHosts = """ + json.dumps(_EMBED_HOSTS) + """;
    const embeds = [];
    document.querySelectorAll('iframe').forEach(f => {
        const s = f.src || f.getAttribute('data-src') || '';
        if (s && embedHosts.some(h => s.toLowerCase().includes(h))) {
            embeds.push(s);
        }
    });
    rpt('scan', {
        videos: document.querySelectorAll('video').length,
        iframes: document.querySelectorAll('iframe').length,
        embeds: embeds
    });
}"""


class BrowseSession:
    """A single Playwright browse session with video detection and CDP recording."""

    def __init__(self, sid, url, sio, resolution="1920x1080",
                 auto_record=True, output_format="mp4", bitrate="5M"):
        self.sid = sid
        self.url = url
        self.sio = sio
        self.resolution = resolution
        self.auto_record = auto_record
        self.output_format = output_format
        self.bitrate = bitrate
        self.running = False
        self._save = True
        self._thread = None
        self._loop = None
        self._page = None
        self._title = ""
        self._t0 = None          # session start epoch
        self._play_t = None       # offset (seconds) when video started playing
        self._end_t = None        # offset (seconds) when video ended
        self._auto_started = False
        self._raw_video = None
        self._tmp = os.path.join(config.DATA_DIR, "browse_sessions", sid)
        self._viddir = os.path.join(self._tmp, "video")

    # -- lifecycle --

    def start(self):
        self.running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self, save=True):
        self._save = save
        self.running = False

    # -- internal --

    def _run(self):
        print(f"[Browse {self.sid}] Thread started for {self.url}")
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._main())
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"[Browse {self.sid}] ERROR: {e}")
            self._emit('browse_error', {'error': str(e)[:300]})
        finally:
            self.running = False
            print(f"[Browse {self.sid}] Thread finished")
            try:
                self._loop.close()
            except Exception:
                pass

        # Save or discard (runs synchronously after event loop closes)
        if self._save and self._raw_video and os.path.isfile(self._raw_video):
            self._save_recording()
        elif not self._save:
            self._emit('browse_session_ended', {'saved': False})
            self._cleanup()
        else:
            self._emit('browse_session_ended', {'saved': False, 'error': 'No recording produced'})
            self._cleanup()

    def _emit(self, ev, data=None):
        d = dict(data or {})
        d['session_id'] = self.sid
        try:
            self.sio.emit(ev, d)
        except Exception:
            pass

    def _on_video_event(self, raw):
        """Callback exposed to the browser page — called from Playwright's event loop."""
        try:
            evt = json.loads(raw)
            offset = round(time.time() - self._t0, 2) if self._t0 else 0
            evt['offset'] = offset
            self._emit('browse_video_event', evt)

            # Report detected embed iframes
            embeds = evt.get('embeds', [])
            if embeds:
                self._emit('browse_embed_found', {'embeds': embeds})

            # Auto-record: first video play triggers recording marker
            if evt.get('type') == 'playing' and self.auto_record and not self._auto_started:
                self._auto_started = True
                self._play_t = offset
                self._emit('browse_auto_record', {
                    'msg': 'Video playing — recording',
                    'offset': offset,
                    'duration': evt.get('dur', 0),
                })

            # Auto-stop: video ended
            if evt.get('type') == 'ended' and self._auto_started:
                self._end_t = offset
                self._emit('browse_video_ended', {'msg': 'Video ended', 'offset': offset})
                self.running = False
        except Exception:
            pass

    async def _main(self):
        from playwright.async_api import async_playwright

        os.makedirs(self._viddir, exist_ok=True)
        self._t0 = time.time()

        async with async_playwright() as pw:
            browser, ctx = await create_browser_context(
                pw, self.resolution, record_video_dir=self._viddir
            )

            async def _adblock_route(route):
                req = route.request
                if _is_ad_request(req.url, req.resource_type):
                    await route.abort()
                else:
                    await route.continue_()

            await ctx.route("**/*", _adblock_route)

            page = await ctx.new_page()
            self._page = page
            page.on("popup", lambda popup: asyncio.create_task(popup.close()))
            page.on("dialog", lambda dialog: asyncio.create_task(dialog.dismiss()))

            # Expose video-event callback so injected JS can report back
            await page.expose_function('__vdCb', self._on_video_event)

            # Quick HTTP prefetch to find embeds in raw HTML (works even
            # when CF blocks headless browsers for certain URL patterns).
            _prefetch_embeds_result, _prefetch_title = await self._loop.run_in_executor(
                None, _prefetch_embeds, self.url
            )
            _prefetch_results = _prefetch_embeds_result
            if _prefetch_results:
                print(f"[Browse {self.sid}] Prefetch embeds: {_prefetch_results}")
                self._emit('browse_embed_found', {'embeds': _prefetch_results})
            if _prefetch_title and not self._title:
                self._title = _prefetch_title

            # Intercept the initial HTML response to find embed iframes
            # BEFORE Cloudflare JS can clear/alter the DOM.
            _response_embeds = []

            async def _on_nav_response(response):
                if _response_embeds:
                    return
                try:
                    ct = response.headers.get("content-type", "")
                    if "text/html" not in ct:
                        return
                    body = await response.text()
                    if len(body) < 500:
                        return
                    import re as _re
                    hosts_pat = "|".join(_re.escape(h) for h in _EMBED_HOSTS)
                    for m in _re.finditer(
                        r'(?:src|data-src)\s*=\s*["\']'
                        r'(https?://[^"\']*?(?:' + hosts_pat + r')[^"\']*?)["\']',
                        body, _re.IGNORECASE
                    ):
                        url = m.group(1)
                        if url not in _response_embeds:
                            _response_embeds.append(url)
                    # Also grab <title> from raw HTML
                    tm = _re.search(r'<title[^>]*>([^<]+)</title>', body, _re.IGNORECASE)
                    if tm and not self._title:
                        self._title = tm.group(1).strip()
                except Exception:
                    pass

            page.on("response", _on_nav_response)

            self._emit('browse_status', {'status': 'loading', 'url': self.url})
            print(f"[Browse {self.sid}] Navigating to {self.url}")

            # Navigate — use wait_until="commit" to avoid blocking on
            # Cloudflare challenges that temporarily clear the DOM.
            try:
                await page.goto(self.url, wait_until="commit", timeout=30000)
                print(f"[Browse {self.sid}] Response committed")
            except Exception as e:
                print(f"[Browse {self.sid}] Navigation FAILED: {e}")
                self._emit('browse_error', {'error': f'Page load failed: {str(e)[:200]}'})
                await close_context_and_browser(ctx, browser)
                return

            # Wait briefly for the response body to arrive and be parsed
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:
                pass
            # Give the response handler a moment to process
            await asyncio.sleep(0.5)

            # Check for embeds captured from the raw HTML response
            if _response_embeds and not _prefetch_results:
                print(f"[Browse {self.sid}] Response embed scan: {_response_embeds}")
                self._emit('browse_embed_found', {'embeds': _response_embeds})
            elif not _response_embeds and not _prefetch_results:
                print(f"[Browse {self.sid}] No embeds detected")

            # Remove the response interceptor (no longer needed)
            page.remove_listener("response", _on_nav_response)

            # Wait for the page body to have real content (handles
            # Cloudflare challenges that briefly blank the DOM).
            try:
                await page.wait_for_selector("body :first-child", timeout=15000)
            except Exception:
                print(f"[Browse {self.sid}] Timeout waiting for body content")

            try:
                await page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass

            self._title = self._title or (await page.title()) or ""
            w, h = self.resolution.split('x')

            self._emit('browse_status', {
                'status': 'loaded', 'title': self._title,
                'url': self.url, 'vw': int(w), 'vh': int(h),
            })
            print(f"[Browse {self.sid}] Page ready: {self._title}")

            # Inject video detector
            try:
                await page.evaluate(_DETECTOR_JS)
            except Exception:
                pass

            # Screenshot streaming loop (~2 FPS)
            ss = os.path.join(self._tmp, "ss.jpg")
            n = 0
            print(f"[Browse {self.sid}] Starting screenshot loop")
            while self.running:
                try:
                    await page.screenshot(path=ss, type="jpeg", quality=55)
                    with open(ss, 'rb') as f:
                        data = f.read()
                    self._emit('browse_frame', {
                        'img': base64.b64encode(data).decode()
                    })
                    if n == 0:
                        print(f"[Browse {self.sid}] First frame sent ({len(data)} bytes)")
                except Exception as e:
                    if n < 3:
                        print(f"[Browse {self.sid}] Screenshot error: {e}")

                n += 1
                # Re-inject detector every ~3 seconds (handles SPAs / dynamic content)
                if n % 6 == 0:
                    try:
                        await page.evaluate(_DETECTOR_JS)
                    except Exception:
                        pass

                await asyncio.sleep(0.5)

            # Session ending — close context (finalizes CDP video)
            self._emit('browse_status', {'status': 'stopping'})
            self._page = None
            await close_context_and_browser(ctx, browser)

        # Find the CDP video file
        vids = glob.glob(os.path.join(self._viddir, "*.webm"))
        self._raw_video = vids[0] if vids else None

    def _save_recording(self):
        """Create a job from the browse session recording (sync, runs after event loop)."""
        from services.job_manager import create_job, update_job
        from services.storage import get_job_folder

        self._emit('browse_status', {'status': 'saving'})

        job = create_job('record', {
            'url': self.url,
            'title': self._title or self.url,
            'resolution': self.resolution,
            'format': self.output_format,
            'source': 'browse',
        })
        jid = job['id']
        jfolder = get_job_folder(jid)
        outdir = os.path.join(jfolder, "output")
        tmpdir = os.path.join(jfolder, "temp")
        os.makedirs(outdir, exist_ok=True)
        os.makedirs(tmpdir, exist_ok=True)

        update_job(jid, status="post-processing", progress=50)
        self._emit('browse_save_progress', {'job_id': jid, 'progress': 50})

        current = self._raw_video

        # Trim to video segment if we detected play/end offsets
        if self._play_t is not None:
            ts = max(0, self._play_t - 0.5)
            te = (self._end_t + 0.5) if self._end_t else None
            trimmed = os.path.join(tmpdir, "trimmed.webm")
            cmd = [config.FFMPEG_PATH, "-y", "-i", current]
            if ts > 0:
                cmd += ["-ss", f"{ts:.1f}"]
            if te:
                cmd += ["-to", f"{te:.1f}"]
            cmd += ["-c", "copy", trimmed]
            ok, _ = run_ffmpeg(cmd, timeout=300)
            if ok and os.path.isfile(trimmed):
                current = trimmed

        update_job(jid, progress=70)
        self._emit('browse_save_progress', {'job_id': jid, 'progress': 70})

        # Convert to target format
        fmt = self.output_format
        final = os.path.join(outdir, f"recording.{fmt}")

        if fmt == "webm":
            shutil.copy2(current, final)
        elif getattr(config, "FFMPEG_IS_PLAYWRIGHT", False):
            final = os.path.join(outdir, "recording.webm")
            shutil.copy2(current, final)
            fmt = "webm"
        else:
            conv = os.path.join(tmpdir, f"out.{fmt}")
            cmd = [
                config.FFMPEG_PATH, "-y", "-i", current,
                "-c:v", "libx264", "-preset", "fast",
                "-b:v", self.bitrate, "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", conv
            ]
            ok, _ = run_ffmpeg(cmd, timeout=600)
            if ok and os.path.isfile(conv):
                shutil.copy2(conv, final)
            else:
                # Fallback: save as webm
                final = os.path.join(outdir, "recording.webm")
                shutil.copy2(current, final)
                fmt = "webm"

        update_job(jid, progress=85)

        # Generate thumbnail
        thumb = os.path.join(jfolder, "thumbnail.jpg")
        if not getattr(config, "FFMPEG_IS_PLAYWRIGHT", False):
            cmd = build_thumbnail_command(final, thumb)
            ok, _ = run_ffmpeg(cmd, timeout=30)
            if ok:
                update_job(jid, thumbnail="thumbnail.jpg")

        now = datetime.now(timezone.utc).isoformat()
        update_job(jid, status="completed", progress=100,
                   completed_at=now, output_file=f"recording.{fmt}")

        self._emit('browse_save_complete', {'job_id': jid, 'file': f"recording.{fmt}"})
        self._cleanup()

    def _cleanup(self):
        try:
            shutil.rmtree(self._tmp, ignore_errors=True)
        except Exception:
            pass

    # -- interaction forwarding --

    def click(self, x, y):
        if not self._page or not self._loop or not self.running:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._do_click(x, y), self._loop)
        except Exception:
            pass

    async def _do_click(self, x, y):
        try:
            await self._page.mouse.click(x, y)
            await asyncio.sleep(0.3)
            try:
                await self._page.evaluate(_DETECTOR_JS)
            except Exception:
                pass
        except Exception:
            pass

    def scroll(self, x, y, delta):
        if not self._page or not self._loop or not self.running:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._do_scroll(x, y, delta), self._loop)
        except Exception:
            pass

    async def _do_scroll(self, x, y, delta):
        try:
            await self._page.mouse.move(x, y)
            await self._page.mouse.wheel(0, delta)
        except Exception:
            pass


class BrowseSessionManager:
    """Manages all active browse sessions."""

    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

    def start_session(self, sid, url, sio, **kwargs):
        with self._lock:
            old = self._sessions.get(sid)
            if old:
                old.stop(save=False)
            s = BrowseSession(sid, url, sio, **kwargs)
            self._sessions[sid] = s
            s.start()
            return sid

    def stop_session(self, sid, save=True):
        with self._lock:
            s = self._sessions.pop(sid, None)
            if s:
                s.stop(save=save)
                return True
            return False

    def click(self, sid, x, y):
        s = self._sessions.get(sid)
        if s:
            s.click(x, y)

    def scroll(self, sid, x, y, delta):
        s = self._sessions.get(sid)
        if s:
            s.scroll(x, y, delta)
