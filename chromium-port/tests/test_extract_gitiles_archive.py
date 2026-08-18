from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "extract-gitiles-archive.py"
SPEC = importlib.util.spec_from_file_location("extract_gitiles_archive", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GitilesExtractionTests(unittest.TestCase):
    def test_regular_files_and_symlinks_are_materialized_portably(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "fixture.tar.gz"
            destination = root / "output"
            with tarfile.open(archive, "w:gz") as bundle:
                data = b"payload\n"
                regular = tarfile.TarInfo("folder/target.txt")
                regular.size = len(data)
                bundle.addfile(regular, io.BytesIO(data))
                link = tarfile.TarInfo("portable-link")
                link.type = tarfile.SYMTYPE
                link.linkname = "folder/target.txt"
                bundle.addfile(link)

            MODULE.extract(archive, destination)

            self.assertEqual((destination / "folder" / "target.txt").read_bytes(), b"payload\n")
            self.assertEqual((destination / "portable-link").read_text(encoding="utf-8"), "folder/target.txt")

    def test_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "fixture.tar.gz"
            destination = root / "output"
            with tarfile.open(archive, "w:gz") as bundle:
                data = b"blocked"
                entry = tarfile.TarInfo("../outside.txt")
                entry.size = len(data)
                bundle.addfile(entry, io.BytesIO(data))

            with self.assertRaises(ValueError):
                MODULE.extract(archive, destination)
            self.assertFalse((root / "outside.txt").exists())


if __name__ == "__main__":
    unittest.main()
