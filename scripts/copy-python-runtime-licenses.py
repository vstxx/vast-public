"""Collect license metadata for Python packages bundled in the Avidae runtime."""

from __future__ import annotations

import importlib.metadata as metadata
import json
import re
import shutil
import sys
from pathlib import Path

from packaging.requirements import InvalidRequirement, Requirement


def normalized_name(value: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-")


def active_requirement_name(value: str) -> str:
    try:
        requirement = Requirement(value)
    except InvalidRequirement:
        return ""
    if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
        return ""
    return requirement.name


def is_notice(path: Path) -> bool:
    name = path.name.lower()
    return any(marker in name for marker in ("license", "licence", "copying", "notice"))


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: copy-python-runtime-licenses.py OUTPUT PACKAGE [PACKAGE ...]")

    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    pending = list(sys.argv[2:])
    seen: set[str] = set()
    inventory: list[dict[str, object]] = []

    while pending:
        requested = pending.pop(0)
        distribution = metadata.distribution(requested)
        package_name = distribution.metadata.get("Name") or requested
        key = normalized_name(package_name)
        if key in seen:
            continue
        seen.add(key)

        dependencies = []
        for requirement in distribution.requires or []:
            dependency = active_requirement_name(requirement)
            if not dependency:
                continue
            dependencies.append(dependency)
            try:
                metadata.distribution(dependency)
            except metadata.PackageNotFoundError:
                continue
            pending.append(dependency)

        destination = output / f"{key}-{distribution.version}"
        copied: list[str] = []
        for entry in distribution.files or []:
            relative = Path(str(entry).replace("\\", "/"))
            if not is_notice(relative):
                continue
            source = Path(distribution.locate_file(entry)).resolve()
            if not source.is_file():
                continue
            destination.mkdir(parents=True, exist_ok=True)
            target_name = f"{len(copied) + 1:02d}-{relative.name}"
            shutil.copyfile(source, destination / target_name)
            copied.append(target_name)

        if not copied:
            raise RuntimeError(f"No license or notice file found for bundled Python package {package_name} {distribution.version}.")

        inventory.append({
            "name": package_name,
            "version": distribution.version,
            "licenseExpression": distribution.metadata.get("License-Expression") or "",
            "license": distribution.metadata.get("License") or "",
            "licenseClassifiers": [
                value for value in distribution.metadata.get_all("Classifier", [])
                if value.startswith("License ::")
            ],
            "dependencies": sorted(set(dependencies), key=str.lower),
            "files": copied,
        })

    inventory.sort(key=lambda item: str(item["name"]).lower())
    (output / "python-packages.json").write_text(
        json.dumps(inventory, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"packages": len(inventory), "output": str(output)}))


if __name__ == "__main__":
    main()
