import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resources" / "avidae"))

_temp = tempfile.TemporaryDirectory(prefix="vast-avidae-test-")
TOKEN = "a" * 64
PORT = "51234"
os.environ.update({
    "AVIDAE_DATA_DIR": _temp.name,
    "AVIDAE_AUTH_TOKEN": TOKEN,
    "AVIDAE_EMBEDDED": "1",
    "AVIDAE_DEBUG": "0",
    "AVIDAE_HOST": "127.0.0.1",
    "PORT": PORT,
})

from app import app, socketio, _approved_path  # noqa: E402
from security import _SafeRedirectHandler, is_public_url, resolve_public_url  # noqa: E402


class VideoAudioSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.host = {"Host": f"127.0.0.1:{PORT}"}
        self.authorized = {**self.host, "Authorization": f"Bearer {TOKEN}"}

    def test_http_requires_exact_token_and_host(self):
        self.assertEqual(self.client.get("/api/stats", headers=self.host).status_code, 401)
        self.assertEqual(self.client.get("/api/stats", headers={**self.host, "Authorization": "Bearer wrong"}).status_code, 401)
        self.assertEqual(self.client.get("/api/stats", headers=self.authorized).status_code, 200)
        self.assertEqual(self.client.get("/api/stats", headers={**self.authorized, "Host": "evil.test"}).status_code, 400)

    def test_socketio_requires_token(self):
        denied = socketio.test_client(app, headers=self.host)
        self.assertFalse(denied.is_connected())
        allowed = socketio.test_client(app, headers=self.authorized)
        self.assertTrue(allowed.is_connected())
        allowed.disconnect()

    def test_mutating_api_rejects_wrong_content_type(self):
        response = self.client.post("/api/jobs", data="not json", headers=self.authorized)
        self.assertEqual(response.status_code, 415)

    def test_paths_must_remain_in_real_avidae_roots(self):
        inside = Path(_temp.name) / "uploads" / "inside.txt"
        inside.parent.mkdir(parents=True, exist_ok=True)
        inside.write_text("ok", encoding="utf-8")
        outside = Path(_temp.name).parent / "outside-avidae.txt"
        outside.write_text("no", encoding="utf-8")
        try:
            self.assertEqual(_approved_path(str(inside)), str(inside.resolve()))
            self.assertIsNone(_approved_path(str(outside)))
            self.assertIsNone(_approved_path(str(Path(_temp.name) / "uploads" / ".." / ".." / outside.name)))
        finally:
            outside.unlink(missing_ok=True)

    def test_dns_and_redirect_validation_reject_private_addresses(self):
        public_answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        private_answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]
        with patch("socket.getaddrinfo", return_value=public_answer):
            parsed, addresses = resolve_public_url("https://example.test/path")
            self.assertEqual(parsed.scheme, "https")
            self.assertIn("93.184.216.34", addresses)
        with patch("socket.getaddrinfo", return_value=private_answer):
            self.assertFalse(is_public_url("http://redirected.test/private"))
            with self.assertRaises(ValueError):
                _SafeRedirectHandler().redirect_request(None, None, 302, "Found", {}, "http://redirected.test/private")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        _temp.cleanup()
