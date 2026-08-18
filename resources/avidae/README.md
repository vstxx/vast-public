# Video & Audio — Local Media Tools

A dark-themed Flask web app for background browser recording sessions, direct media downloads, video conversion, and audio extraction.

## Features

- **Record** — Launch a headless browser via Playwright, navigate to any page, click play, and capture video+audio with FFmpeg
- **Download** — Direct download of public media URLs
- **Convert** — Transcode videos between formats with FFmpeg
- **Extract Audio** — Pull audio tracks from video files
- **Jobs** — Live dashboard of all background jobs with status, progress, logs
- **Settings** — Configure defaults for recording, paths, concurrency

## Tech Stack

- **Backend**: Flask, Flask-SocketIO, Playwright, FFmpeg
- **Frontend**: Vanilla HTML/CSS/JS, dark theme
- **Storage**: Local filesystem + SQLite metadata

## Quick Start

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Install Playwright browsers
playwright install chromium

# 3. Ensure FFmpeg is on PATH
ffmpeg -version

# 4. Run the app
python app.py
```

Open http://localhost:5000 in your browser.

## Project Structure

```
Video & Audio/ (stored internally under `avidae/` for compatibility)
├── app.py                  # Flask entry point + routes
├── config.py               # Configuration
├── database.py             # SQLite schema & helpers
├── requirements.txt
├── services/
│   ├── job_manager.py      # Job lifecycle & orchestration
│   ├── recorder.py         # Playwright + FFmpeg recording
│   ├── downloader.py       # Direct media download
│   ├── converter.py        # Video transcoding
│   ├── audio_extractor.py  # Audio extraction
│   ├── storage.py          # Filesystem management
│   └── logger.py           # Per-job logging
├── utils/
│   ├── ffmpeg_helper.py    # FFmpeg command builders
│   └── playwright_helper.py# Browser session helpers
├── static/
│   ├── css/style.css       # Dark theme styles
│   └── js/app.js           # Frontend logic + polling
├── templates/              # Jinja2 HTML templates
└── data/
    ├── jobs/               # Per-job folders
    └── avidae.db            # SQLite database
```

## Job Lifecycle

`queued` → `analyzing` → `recording` → `post-processing` → `completed`

Jobs can also transition to `failed` or `cancelled` at any point.

Each job gets its own folder under `data/jobs/<job_id>/` containing:
- `metadata.json` — Job config and status
- `job.log` — Timestamped log
- `output/` — Final files
- `temp/` — Intermediate files
- `thumbnail.jpg` — Auto-generated preview

## License

MIT
