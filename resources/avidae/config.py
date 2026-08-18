import os
import secrets
import shutil

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.environ.get("AVIDAE_DATA_DIR") or os.path.join(BASE_DIR, "data"))
JOBS_DIR = os.path.join(DATA_DIR, "jobs")
DOWNLOADS_DIR = os.path.join(DATA_DIR, "downloads")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "avidae.db")

# Ensure dirs exist
for d in [DATA_DIR, JOBS_DIR, DOWNLOADS_DIR, UPLOADS_DIR]:
    os.makedirs(d, exist_ok=True)

# Flask
SECRET_KEY = os.environ.get("AVIDAE_SECRET") or secrets.token_hex(32)
DEBUG = os.environ.get("AVIDAE_DEBUG", "1") == "1"

# Recording defaults
DEFAULT_RESOLUTION = "1920x1080"
DEFAULT_FPS = 30
DEFAULT_BITRATE = "5M"
DEFAULT_MAX_DURATION = 3600  # seconds
DEFAULT_FORMAT = "mp4"
DEFAULT_DELAY = 3  # seconds before recording starts

# FFmpeg
def _find_playwright_ffmpeg():
    local_app = os.path.join(os.path.expanduser("~"), "AppData", "Local", "ms-playwright")
    if os.path.isdir(local_app):
        for d in sorted(os.listdir(local_app), reverse=True):
            exe = os.path.join(local_app, d, "ffmpeg-win64.exe")
            if os.path.isfile(exe):
                return exe
    return None


def _resolve_executable(env_name, default_path, path_name, extra_finder=None):
    candidates = [
        os.environ.get(env_name),
        default_path,
        shutil.which(path_name),
        extra_finder() if extra_finder else None,
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return os.environ.get(env_name) or default_path or path_name


FFMPEG_PATH = _resolve_executable(
    "FFMPEG_PATH",
    None,
    "ffmpeg",
    _find_playwright_ffmpeg,
)
FFMPEG_IS_PLAYWRIGHT = (
    os.path.basename(FFMPEG_PATH).lower() == "ffmpeg-win64.exe"
    and "ms-playwright" in FFMPEG_PATH.lower()
)
FFPROBE_PATH = _resolve_executable(
    "FFPROBE_PATH",
    None,
    "ffprobe",
)

# Playwright
HEADLESS = True
BROWSER_TYPE = "chromium"  # chromium, firefox, webkit

# Allowed download domains (simple public media)
ALLOWED_DOWNLOAD_EXTENSIONS = {".mp4", ".webm", ".mkv", ".avi", ".mov", ".mp3", ".wav", ".ogg", ".flac"}

# Max concurrent jobs
MAX_CONCURRENT_JOBS = 3

# Upload
MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB
ALLOWED_UPLOAD_EXTENSIONS = {".mp4", ".webm", ".mkv", ".avi", ".mov", ".mp3", ".wav", ".ogg", ".flac", ".ts", ".m4a", ".opus", ".aac", ".wma", ".srt", ".ass", ".ssa", ".vtt", ".lrc", ".sub"}

# Live preview interval (seconds)
PREVIEW_INTERVAL = 5
