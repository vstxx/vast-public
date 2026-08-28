import ipaddress
import http.client
import socket
import ssl
import urllib.parse
import urllib.request

MAX_REDIRECTS = 5


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
