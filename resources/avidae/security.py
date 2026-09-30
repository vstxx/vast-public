import ipaddress
import http.client
import os
import re
import socket
import ssl
import urllib.parse
import urllib.request

MAX_REDIRECTS = 5

_MEDIA_FORMATS = {
    "browse": frozenset(("mp4", "webm", "mkv")),
    "record": frozenset(("mp4", "webm", "mkv")),
    "convert": frozenset(("mp4", "webm", "mkv", "avi")),
    "video_merge": frozenset(("mp4", "mkv", "webm")),
    "audio_convert": frozenset(("ogg", "mp3", "opus", "wav", "flac", "aac", "m4a")),
    "audio_record": frozenset(("mp3", "wav", "ogg", "flac", "aac", "m4a")),
    "extract_audio": frozenset(("mp3", "wav", "ogg", "flac", "aac")),
}


def validated_media_format(kind, value):
    if not isinstance(value, str) or value not in _MEDIA_FORMATS[kind]:
        raise ValueError("Unsupported media output format")
    return value


def validated_browse_session_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise ValueError("Invalid browse session ID")
    return value


def contained_path(root, *parts):
    """Resolve existing symlinks/junctions; reject descendants outside root."""
    root_real = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(root, *parts))
    try:
        if os.path.commonpath((root_real, candidate)) != root_real or candidate == root_real:
            raise ValueError("Path is outside the approved directory")
    except ValueError as exc:
        raise ValueError("Path is outside the approved directory") from exc
    return candidate


def contained_job_path(job_folder, *parts):
    import config
    jobs_root = contained_path(config.DATA_DIR, "jobs")
    job = os.path.realpath(job_folder)
    if os.path.commonpath((jobs_root, job)) != jobs_root or job == jobs_root or os.path.islink(job_folder) or getattr(os.path, "isjunction", lambda _path: False)(job_folder):
        raise ValueError("Job path is outside Video & Audio storage")
    if not parts:
        return job
    directory = contained_path(job, parts[0])
    if os.path.islink(os.path.join(job, parts[0])) or getattr(os.path, "isjunction", lambda _path: False)(os.path.join(job, parts[0])):
        raise ValueError("Job output directory is a link")
    return contained_path(directory, *parts[1:]) if len(parts) > 1 else directory


def resolve_public_url(raw_url):
    if not isinstance(raw_url, str) or len(raw_url) > 131072:
        raise ValueError("URL is invalid or too long")
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only public http(s) URLs are allowed")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    except OSError as exc:
        raise ValueError("URL host could not be resolved") from exc
    if not addresses:
        raise ValueError("URL host did not resolve")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        if not ip.is_global or ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
            raise ValueError("URL resolves to a non-public address")
    return parsed, addresses


def is_public_url(raw_url):
    try:
        resolve_public_url(raw_url)
        return True
    except (ValueError, OSError):
        return False


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        super().__init__()
        self.redirects = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.redirects += 1
        if self.redirects > MAX_REDIRECTS:
            raise ValueError("Too many remote redirects")
        resolve_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _connect_approved(addresses, port, timeout, source_address=None):
    last_error = None
    for address in sorted(addresses):
        try:
            return socket.create_connection((address, port), timeout, source_address)
        except OSError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError("URL host did not resolve")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, approved_addresses, **kwargs):
        super().__init__(host, **kwargs)
        self._approved_addresses = approved_addresses

    def connect(self):
        original = self._create_connection
        self._create_connection = lambda _address, timeout=None, source_address=None, **_kwargs: _connect_approved(
            self._approved_addresses, self.port, timeout, source_address
        )
        try:
            super().connect()
        finally:
            self._create_connection = original


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, approved_addresses, **kwargs):
        super().__init__(host, **kwargs)
        self._approved_addresses = approved_addresses

    def connect(self):
        original = self._create_connection
        self._create_connection = lambda _address, timeout=None, source_address=None, **_kwargs: _connect_approved(
            self._approved_addresses, self.port, timeout, source_address
        )
        try:
            super().connect()
        finally:
            self._create_connection = original


class _SafeHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        _parsed, addresses = resolve_public_url(req.full_url)
        return self.do_open(lambda host, **kwargs: _PinnedHTTPConnection(host, addresses, **kwargs), req)


class _SafeHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        _parsed, addresses = resolve_public_url(req.full_url)
        return self.do_open(lambda host, **kwargs: _PinnedHTTPSConnection(host, addresses, **kwargs), req)


def safe_urlopen(request_or_url, timeout=30, context=None):
    raw_url = request_or_url.full_url if isinstance(request_or_url, urllib.request.Request) else str(request_or_url)
    resolve_public_url(raw_url)
    handlers = [_SafeRedirectHandler(), _SafeHTTPHandler(), _SafeHTTPSHandler(context=context or ssl.create_default_context())]
    opener = urllib.request.build_opener(*handlers)
    response = opener.open(request_or_url, timeout=timeout)
    resolve_public_url(response.geturl())
    return response
