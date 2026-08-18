import os
import re
import shutil
import config


def ensure_job_folder(job_id):
    job_dir = os.path.join(config.JOBS_DIR, job_id)
    for sub in ["output", "temp"]:
        os.makedirs(os.path.join(job_dir, sub), exist_ok=True)
    return job_dir


def get_job_folder(job_id):
    return os.path.join(config.JOBS_DIR, job_id)


def delete_job_folder(job_id):
    job_dir = get_job_folder(job_id)
    if os.path.isdir(job_dir):
        shutil.rmtree(job_dir, ignore_errors=True)
        return True
    return False


def list_job_folders():
    if not os.path.isdir(config.JOBS_DIR):
        return []
    return [
        d for d in os.listdir(config.JOBS_DIR)
        if os.path.isdir(os.path.join(config.JOBS_DIR, d))
    ]


def get_output_files(job_id):
    output_dir = os.path.join(config.JOBS_DIR, job_id, "output")
    if not os.path.isdir(output_dir):
        return []
    return [f for f in os.listdir(output_dir) if os.path.isfile(os.path.join(output_dir, f))]


def get_file_path(job_id, filename):
    safe_name = os.path.basename(filename)
    path = os.path.join(config.JOBS_DIR, job_id, "output", safe_name)
    if os.path.isfile(path):
        return path
    # Check root of job folder (thumbnail, preview, etc.)
    path2 = os.path.join(config.JOBS_DIR, job_id, safe_name)
    if os.path.isfile(path2):
        return path2
    return None


def get_disk_usage():
    total = 0
    for dirpath, _dirnames, filenames in os.walk(config.DATA_DIR):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.isfile(fp):
                total += os.path.getsize(fp)
    return total


def get_job_size(job_id):
    job_dir = get_job_folder(job_id)
    total = 0
    if os.path.isdir(job_dir):
        for dirpath, _dirnames, filenames in os.walk(job_dir):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
    return total


def format_size(size_bytes):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def save_upload(file_storage, filename=None):
    if not filename:
        filename = file_storage.filename or "upload"
    safe_name = re.sub(r'[^\w\-_.]', '_', os.path.basename(filename))
    path = os.path.join(config.UPLOADS_DIR, safe_name)
    # Avoid overwrite
    base, ext = os.path.splitext(safe_name)
    counter = 1
    while os.path.exists(path):
        path = os.path.join(config.UPLOADS_DIR, f"{base}_{counter}{ext}")
        counter += 1
    file_storage.save(path)
    return path
