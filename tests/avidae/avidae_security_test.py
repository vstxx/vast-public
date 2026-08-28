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

from app import app, socketio, _approved_path, _spreadsheet_safe  # noqa: E402
from security import _SafeRedirectHandler, _connect_approved, is_public_url, resolve_public_url  # noqa: E402


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
        unauthorized = self.client.post("/api/jobs", json={"type": "record", "params": {"url": "https://example.com"}}, headers=self.host)
        self.assertEqual(unauthorized.status_code, 401)
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

    def test_all_private_ipv4_ipv6_and_metadata_ranges_are_rejected(self):
        blocked = [
            "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254",
            "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::"
        ]
        for address in blocked:
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            answer = [(family, socket.SOCK_STREAM, 6, "", (address, 80, 0, 0) if family == socket.AF_INET6 else (address, 80))]
            with patch("socket.getaddrinfo", return_value=answer):
                self.assertFalse(is_public_url("http://metadata.test/latest"), address)

    def test_connection_uses_only_the_prevalidated_address_set(self):
        sentinel = object()
        with patch("socket.create_connection", return_value=sentinel) as connect:
            result = _connect_approved({"93.184.216.34"}, 443, 5)
        self.assertIs(result, sentinel)
        connect.assert_called_once_with(("93.184.216.34", 443), 5, None)

    def test_socket_origin_and_csv_formula_cells_are_hardened(self):
        denied_origin = socketio.test_client(app, headers={**self.authorized, "Origin": "https://evil.test"})
        self.assertFalse(denied_origin.is_connected())
        for value in ("=cmd()", "+SUM(A1)", "-1+2", "@IMPORTXML(A1)"):
            self.assertEqual(_spreadsheet_safe(value), "'" + value)
        self.assertEqual(_spreadsheet_safe("ordinary"), "ordinary")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        _temp.cleanup()
