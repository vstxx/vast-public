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

with patch("threading.Thread.start"):
    # The HTTP/security fixture never exercises scheduled jobs. Starting the
    # production scheduler here races TemporaryDirectory cleanup on Windows
    # while its SQLite connection is open.
    from app import app, socketio, _approved_path, _spreadsheet_safe  # noqa: E402
from security import _SafeRedirectHandler, _connect_approved, contained_job_path, is_public_url, resolve_public_url, validated_media_format  # noqa: E402
from services.browse_session import BrowseSession  # noqa: E402


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

    def test_browse_session_rejects_traversal_and_unsafe_formats_before_start(self):
        for sid in ("../outside", "..\\outside", "C:\\outside", "/tmp/outside", "a/b", "a\x00b", 123):
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                BrowseSession(sid, "https://example.com", socketio)
        with self.assertRaises(ValueError):
            BrowseSession("valid-id", "https://example.com", socketio, output_format="../outside")

    def test_browse_start_rejects_malicious_socket_payloads_without_starting_a_thread(self):
        client = socketio.test_client(app, headers=self.authorized)
        try:
            with patch("app._is_safe_analysis_url", return_value=True), patch("app.browse_manager.start_session") as start:
                client.emit("browse_start", {"url": "https://example.com", "session_id": "../outside"})
                client.emit("browse_start", {"url": "https://example.com", "session_id": "safe", "format": "../outside"})
                start.assert_not_called()
                self.assertEqual([item["name"] for item in client.get_received()].count("browse_error"), 2)
        finally:
            client.disconnect()

    def test_browse_cleanup_never_follows_a_replaced_session_directory(self):
        outside = Path(_temp.name).parent / "vast-avidae-cleanup-outside"
        outside.mkdir(exist_ok=True)
        marker = outside / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        session = BrowseSession("safe-id", "https://example.com", socketio)
        session_dir = Path(session._tmp)
        session_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            session_dir.symlink_to(outside, target_is_directory=True)
        except OSError:
            marker.unlink(missing_ok=True)
            outside.rmdir()
            self.skipTest("Creating a directory symlink is unavailable")
        try:
            session._cleanup()
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        finally:
            session_dir.unlink(missing_ok=True)
            marker.unlink(missing_ok=True)
            outside.rmdir()

    def test_browse_cleanup_rejects_outside_target_even_without_symlinks(self):
        outside = Path(_temp.name).parent / "vast-avidae-cleanup-guard.txt"
        outside.write_text("keep", encoding="utf-8")
        try:
            session = BrowseSession("safe-id", "https://example.com", socketio)
            session._tmp = str(outside)
            session._cleanup()
            self.assertEqual(outside.read_text(encoding="utf-8"), "keep")
        finally:
            outside.unlink(missing_ok=True)

    def test_job_output_path_rejects_traversal(self):
        job_folder = Path(_temp.name) / "jobs" / "job-safe"
        (job_folder / "output").mkdir(parents=True, exist_ok=True)
        with self.assertRaises(ValueError):
            contained_job_path(str(job_folder), "output", "../../outside.mp4")
        self.assertEqual(contained_job_path(str(job_folder), "output", "recording.mp4"), str((job_folder / "output" / "recording.mp4").resolve()))

    def test_media_format_allowlist_preserves_supported_formats_only(self):
        supported = {
            "browse": ("mp4", "webm", "mkv"), "record": ("mp4", "webm", "mkv"),
            "convert": ("mp4", "webm", "mkv", "avi"), "video_merge": ("mp4", "mkv", "webm"),
            "audio_convert": ("ogg", "mp3", "opus", "wav", "flac", "aac", "m4a"),
            "audio_record": ("mp3", "wav", "ogg", "flac", "aac", "m4a"),
            "extract_audio": ("mp3", "wav", "ogg", "flac", "aac"),
        }
        for kind, formats in supported.items():
            for media_format in formats:
                self.assertEqual(validated_media_format(kind, media_format), media_format)
            for malicious in ("../outside", "mp4/../../outside", "MP4", "mp4\x00", None, 1):
                with self.subTest(kind=kind, malicious=malicious), self.assertRaises(ValueError):
                    validated_media_format(kind, malicious)

    def test_media_job_rejects_traversal_format_without_creating_job(self):
        with patch("app.create_job") as create_job:
            for job_type, key in (("audio_record", "format"), ("record", "format"), ("extract_audio", "audio_format")):
                params = {key: "../outside"}
                if job_type == "record":
                    params["url"] = "https://example.com"
                if job_type == "extract_audio":
                    params["input_file"] = "not-found"
                response = self.client.post("/api/jobs", json={"type": job_type, "params": params}, headers=self.authorized)
                self.assertEqual(response.status_code, 400, job_type)
            create_job.assert_not_called()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        _temp.cleanup()
