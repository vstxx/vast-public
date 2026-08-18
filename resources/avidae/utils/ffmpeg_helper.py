import subprocess
import os
import re
import json
import threading
import config


def probe_media(filepath):
    cmd = [
        config.FFPROBE_PATH, "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        filepath
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception:
        pass
    return None


def get_duration(filepath):
    info = probe_media(filepath)
    if info and "format" in info:
        return float(info["format"].get("duration", 0))
    return 0


def parse_ffmpeg_progress(line):
    """Parse FFmpeg stderr line for progress info.
    Returns dict with time, speed, bitrate, fps, size or None."""
    result = {}
    # Match time=HH:MM:SS.ms
    m = re.search(r'time=(\d+):(\d+):(\d+)\.(\d+)', line)
    if m:
        h, mi, s, ms = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
        result['time_seconds'] = h * 3600 + mi * 60 + s + ms / 100
    # Match speed=X.Xx
    m = re.search(r'speed=\s*([\d.]+)x', line)
    if m:
        result['speed'] = float(m.group(1))
    # Match bitrate=XXXkbits/s
    m = re.search(r'bitrate=\s*([\d.]+)kbits/s', line)
    if m:
        result['bitrate_kbps'] = float(m.group(1))
    # Match fps=XX
    m = re.search(r'fps=\s*([\d.]+)', line)
    if m:
        result['fps'] = float(m.group(1))
    # Match size=XXXkB
    m = re.search(r'size=\s*(\d+)kB', line)
    if m:
        result['size_kb'] = int(m.group(1))
    return result if result else None


def build_record_command(display, output_path, resolution="1920x1080", fps=30,
                         bitrate="5M", audio=True, format="mp4"):
    w, h = resolution.split("x")
    cmd = [config.FFMPEG_PATH, "-y"]

    if os.name == "nt":
        cmd += ["-f", "gdigrab", "-framerate", str(fps),
                "-video_size", f"{w}x{h}", "-i", f"title={display}"]
    else:
        cmd += ["-f", "x11grab", "-framerate", str(fps),
                "-video_size", f"{w}x{h}", "-i", display]

    if audio:
        if os.name == "nt":
            cmd += ["-f", "dshow", "-i", "audio=virtual-audio-capturer"]
        else:
            cmd += ["-f", "pulse", "-i", "default"]

    cmd += [
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
        "-b:v", bitrate, "-pix_fmt", "yuv420p",
    ]
    if audio:
        cmd += ["-c:a", "aac", "-b:a", "128k"]

    cmd += ["-f", format, output_path]
    return cmd


def build_page_record_command(output_path, resolution="1920x1080", fps=30,
                              bitrate="5M", format="mp4", duration=None):
    w, h = resolution.split("x")
    cmd = [
        config.FFMPEG_PATH, "-y",
        "-f", "rawvideo", "-pix_fmt", "bgra",
        "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", bitrate, "-pix_fmt", "yuv420p",
    ]
    if duration:
        cmd += ["-t", str(duration)]
    cmd += ["-f", format, output_path]
    return cmd


def build_trim_command(input_path, output_path, start=None, end=None):
    cmd = [config.FFMPEG_PATH, "-y", "-i", input_path]
    if start:
        cmd += ["-ss", str(start)]
    if end:
        cmd += ["-to", str(end)]
    cmd += ["-c", "copy", output_path]
    return cmd


def build_convert_command(input_path, output_path, vcodec="libx264",
                          acodec="aac", bitrate=None, resolution=None):
    cmd = [config.FFMPEG_PATH, "-y", "-i", input_path]
    cmd += ["-c:v", vcodec, "-c:a", acodec]
    if bitrate:
        cmd += ["-b:v", bitrate]
    if resolution:
        w, h = resolution.split("x")
        cmd += ["-vf", f"scale={w}:{h}"]
    cmd += [output_path]
    return cmd


def build_extract_audio_command(input_path, output_path, acodec="libmp3lame",
                                bitrate="192k"):
    cmd = [
        config.FFMPEG_PATH, "-y", "-i", input_path,
        "-vn", "-c:a", acodec, "-b:a", bitrate,
        output_path
    ]
    return cmd


def build_thumbnail_command(input_path, output_path, timestamp="00:00:02"):
    cmd = [
        config.FFMPEG_PATH, "-y", "-i", input_path,
        "-ss", timestamp, "-vframes", "1",
        "-vf", "scale=320:-1",
        output_path
    ]
    return cmd


def run_ffmpeg(cmd, logger=None, timeout=None, progress_callback=None, total_duration=None):
    """Run FFmpeg with optional real-time progress parsing.
    progress_callback(pct, info_dict) is called with percentage and parsed info."""
    if logger:
        logger.info(f"FFmpeg command: {' '.join(cmd)}")
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )

        if progress_callback and total_duration and total_duration > 0:
            # Read stderr line-by-line for progress
            stderr_lines = []
            for line in iter(proc.stderr.readline, b''):
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                stderr_lines.append(text)
                info = parse_ffmpeg_progress(text)
                if info and 'time_seconds' in info:
                    pct = min(int(100 * info['time_seconds'] / total_duration), 99)
                    try:
                        progress_callback(pct, info)
                    except Exception:
                        pass
                if logger and text:
                    logger.debug(f"FFmpeg: {text}")
            proc.wait(timeout=timeout)
            stderr_text = "\n".join(stderr_lines)
        else:
            _, stderr = proc.communicate(timeout=timeout)
            stderr_text = stderr.decode("utf-8", errors="replace")
            if logger and stderr_text:
                for line in stderr_text.split("\n")[-20:]:
                    if line.strip():
                        logger.debug(f"FFmpeg: {line.strip()}")

        if proc.returncode != 0:
            # Log the last few lines of stderr for debugging
            if logger:
                last_lines = [l for l in stderr_text.split("\n") if l.strip()][-5:]
                for l in last_lines:
                    logger.error(f"FFmpeg stderr: {l}")

        return proc.returncode == 0, stderr_text
    except subprocess.TimeoutExpired:
        proc.kill()
        if logger:
            logger.error("FFmpeg process timed out")
        return False, "Timeout"
    except Exception as e:
        if logger:
            logger.error(f"FFmpeg error: {e}")
        return False, str(e)
