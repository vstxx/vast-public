"""Safely extract a pinned Gitiles tar archive on Windows.

Git for Windows with core.symlinks=false materializes a repository symlink as a
regular file containing its target. Windows tar instead attempts to create a
real symlink and fails without the relevant privilege. This helper reproduces
Git's portable checkout behavior and rejects paths outside the destination.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys
import tarfile


def safe_target(root: Path, archive_name: str) -> Path:
    normalized = archive_name.replace("\\", "/")
    if normalized.startswith("/"):
        raise ValueError(f"absolute archive path: {archive_name}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"unsafe archive path: {archive_name}")
    candidate = (root / Path(*parts)).resolve()
    if os.path.commonpath((str(root), str(candidate))) != str(root):
        raise ValueError(f"archive path escapes destination: {archive_name}")
    return candidate


def extract(archive: Path, destination: Path) -> None:
    root = destination.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, mode="r:gz") as bundle:
        for member in bundle:
            target = safe_target(root, member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.issym() or member.islnk():
                target.write_text(member.linkname, encoding="utf-8", newline="")
                continue
            if not member.isfile():
                raise ValueError(f"unsupported archive entry: {member.name}")
            source = bundle.extractfile(member)
            if source is None:
                raise ValueError(f"missing archive payload: {member.name}")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract-gitiles-archive.py ARCHIVE DESTINATION", file=sys.stderr)
        return 2
    extract(Path(sys.argv[1]), Path(sys.argv[2]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
