#!/usr/bin/env python3
"""Build and validate the Cat Addon runtime atlas from Cat_Grey_White.aseprite."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import struct
import sys
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ARCHIVE = ROOT / "assets" / "cat-addon" / "Cat_85_Animations.zip"
SOURCE_ROOT = "Cat_85_Animations/"
SOURCE_ASEPRITE = SOURCE_ROOT + "Cat_Grey_White.aseprite"
SOURCE_ATLAS = SOURCE_ROOT + "Cat_Grey_White.png"
PACKAGE_ROOT = ROOT / "assets" / "cat-addon" / "package"
GENERATED_ROOT = ROOT / "assets" / "cat-addon" / "generated"
FRAME_SIZE = 32
EXPECTED_FRAMES = 483
EXPECTED_TAGS = 94
ATLAS_COLUMNS = 16
BUNDLE_VERSION = "2.0.0"


@dataclass(frozen=True)
class SourceTag:
    name: str
    start: int
    end: int
    direction: int
    repeat: int


@dataclass(frozen=True)
class CuratedAnimation:
    id: str
    source_tag: str
    start: int
    end: int
    loop: str
    roles: tuple[str, ...]


CURATED = (
    CuratedAnimation("idle_1", "Idle_1", 0, 3, "repeat", ("idle",)),
    CuratedAnimation("idle_3", "Idle_3", 8, 15, "repeat", ("idle",)),
    CuratedAnimation("walk", "W_1", 32, 39, "repeat", ("movement",)),
    CuratedAnimation("walk_alt", "W_2", 40, 47, "repeat", ("movement",)),
    CuratedAnimation("sit", "Sit_1", 48, 55, "repeat", ("idle", "seated")),
    CuratedAnimation("sit_alt", "Sit_2", 56, 63, "repeat", ("idle", "seated")),
    CuratedAnimation("sit_tilt", "Sit_Tilt_1", 64, 67, "once", ("reaction", "seated")),
    CuratedAnimation("idle_tilt", "Idle_Tilt_1", 74, 77, "once", ("reaction",)),
    CuratedAnimation("sit_lift", "Sit_Lift_1", 86, 89, "once", ("peek", "seated")),
    CuratedAnimation("idle_lift", "Idle_Lift_1", 96, 99, "once", ("peek",)),
    CuratedAnimation("yes", "Idle_Yes", 108, 115, "once", ("reaction",)),
    CuratedAnimation("sit_yes", "Sit_Yes", 116, 123, "once", ("reaction", "seated")),
    CuratedAnimation("no", "Idle_No", 124, 131, "once", ("reaction",)),
    CuratedAnimation("sit_no", "Sit_No", 132, 139, "once", ("error", "seated")),
    CuratedAnimation("dance", "Dance", 140, 147, "once", ("signature",)),
    CuratedAnimation("stand_up", "Stand_Up", 148, 151, "once", ("transition",)),
    CuratedAnimation("sit_down", "SIt_Down", 152, 155, "once", ("transition",)),
    CuratedAnimation("jump_1", "Jump_1", 156, 169, "once", ("movement", "jump")),
    CuratedAnimation("jump_prepare", "Prepare", 170, 173, "once", ("transition", "jump")),
    CuratedAnimation("jump_air", "Jump", 174, 174, "once", ("movement", "jump")),
    CuratedAnimation("jump_brake", "Brake", 175, 176, "once", ("transition", "jump")),
    CuratedAnimation("run_1", "Run_1", 206, 211, "repeat", ("movement", "run")),
    CuratedAnimation("run_2", "Run_2", 212, 217, "repeat", ("movement", "run")),
    CuratedAnimation("rest_1", "Rest_1", 229, 232, "once", ("rest", "transition")),
    CuratedAnimation("rest_2", "Rest_2", 233, 236, "repeat", ("rest",)),
    CuratedAnimation("rest_3", "Rset_3", 237, 240, "repeat", ("rest",)),
    CuratedAnimation("rest_4", "Rest_4", 241, 248, "once", ("rest", "transition")),
    CuratedAnimation("dream", "Dream", 249, 256, "repeat", ("rest", "dream")),
    CuratedAnimation("sneak_idle", "Sneak_up_Idle", 257, 260, "repeat", ("movement", "climb")),
    CuratedAnimation("sneak_move", "SU_move", 261, 264, "repeat", ("movement", "climb")),
    CuratedAnimation("stop", "Stop_1", 265, 268, "once", ("transition",)),
    CuratedAnimation("spawn_1", "Spawn_1", 351, 358, "once", ("entry",)),
    CuratedAnimation("spawn_2", "Spawn_2", 359, 368, "once", ("entry",)),
    CuratedAnimation("attack_1", "Attack_1", 369, 372, "once", ("paw", "attack")),
    CuratedAnimation("attack_2", "Attack_2", 373, 376, "once", ("paw", "attack")),
    CuratedAnimation("attack_3", "Attack_3", 377, 380, "once", ("paw", "attack")),
    CuratedAnimation("attack_4", "Attack_4", 381, 384, "once", ("paw", "attack")),
    CuratedAnimation("push", "Pushes", 403, 410, "once", ("paw",)),
    CuratedAnimation("pull_back", "Pull_Back", 411, 418, "once", ("paw", "transition")),
    CuratedAnimation("walk_back", "W_Back", 419, 426, "repeat", ("movement",)),
    CuratedAnimation("climb_1", "Climb_1", 427, 434, "once", ("climb",)),
    CuratedAnimation("climb_2", "Climb_2", 435, 442, "once", ("climb",)),
    CuratedAnimation("climb_3", "Climb_3", 443, 446, "once", ("climb",)),
    CuratedAnimation("climb_jump_1", "Climb_Jump_1", 447, 452, "once", ("climb", "jump")),
    CuratedAnimation("climb_jump_2", "Climb_Jump_2", 453, 458, "once", ("climb", "jump")),
    CuratedAnimation("scratch_start", "Scratching_Start", 459, 463, "once", ("scratch", "transition")),
    CuratedAnimation("scratch_end", "Scratching_End", 464, 468, "once", ("scratch", "transition")),
    CuratedAnimation("scratch_1", "Scratching_1", 469, 473, "repeat", ("scratch",)),
    CuratedAnimation("scratch_2", "Scratchng_2_85", 474, 481, "repeat", ("scratch",)),
)


def unpack(fmt: str, data: bytes, offset: int) -> tuple:
    return struct.unpack_from("<" + fmt, data, offset)


def read_string(data: bytes, offset: int) -> tuple[str, int]:
    (length,) = unpack("H", data, offset)
    start = offset + 2
    end = start + length
    return data[start:end].decode("utf-8"), end


def decode_source(data: bytes) -> tuple[list[Image.Image], list[int], list[SourceTag]]:
    if len(data) < 128:
        raise ValueError("Aseprite source is truncated")
    file_size, magic, frame_count, width, height, depth = unpack("IHHHHH", data, 0)
    if file_size != len(data) or magic != 0xA5E0:
        raise ValueError("Aseprite header is invalid")
    if (frame_count, width, height, depth) != (EXPECTED_FRAMES, FRAME_SIZE, FRAME_SIZE, 32):
        raise ValueError(f"Unexpected Aseprite geometry: {frame_count} frames, {width}x{height}, {depth} bpp")

    offset = 128
    durations: list[int] = []
    tags: list[SourceTag] = []
    frames: list[Image.Image] = []
    layer_count = 0
    for frame_index in range(frame_count):
        frame_bytes, frame_magic, old_chunks, duration, new_chunks = unpack("IHHH2xI", data, offset)
        if frame_magic != 0xF1FA or frame_bytes < 16 or offset + frame_bytes > len(data):
            raise ValueError(f"Invalid frame header at {frame_index}")
        if duration <= 0 or duration > 2_000:
            raise ValueError(f"Unreasonable frame duration at {frame_index}: {duration}")
        durations.append(duration)
        chunk_count = new_chunks or old_chunks
        cursor = offset + 16
        frame_end = offset + frame_bytes
        canvas = Image.new("RGBA", (FRAME_SIZE, FRAME_SIZE), (0, 0, 0, 0))
        cel_count = 0
        for _ in range(chunk_count):
            chunk_size, chunk_type = unpack("IH", data, cursor)
            if chunk_size < 6 or cursor + chunk_size > frame_end:
                raise ValueError(f"Invalid chunk bounds in frame {frame_index}")
            payload = cursor + 6
            if chunk_type == 0x2004:
                layer_count += 1
                flags, layer_type = unpack("HH", data, payload)
                if layer_type != 0 or not flags & 1:
                    raise ValueError("Canonical source must contain one visible image layer")
            elif chunk_type == 0x2005:
                cel_count += 1
                layer, x, y, opacity = unpack("HhhB", data, payload)
                (cel_type,) = unpack("H", data, payload + 7)
                if layer != 0 or cel_type != 2:
                    raise ValueError(f"Unsupported cel layout in frame {frame_index}")
                cel_width, cel_height = unpack("HH", data, payload + 16)
                raw = zlib.decompress(data[payload + 20:cursor + chunk_size])
                expected = cel_width * cel_height * 4
                if len(raw) != expected:
                    raise ValueError(f"Cel byte count mismatch in frame {frame_index}")
                cel = Image.frombytes("RGBA", (cel_width, cel_height), raw)
                if opacity != 255:
                    cel.putalpha(cel.getchannel("A").point(lambda alpha: alpha * opacity // 255))
                canvas.alpha_composite(cel, (x, y))
            elif chunk_type == 0x2018:
                (tag_count,) = unpack("H", data, payload)
                tag_cursor = payload + 10
                for _ in range(tag_count):
                    start, end = unpack("HH", data, tag_cursor)
                    direction = data[tag_cursor + 4]
                    (repeat,) = unpack("H", data, tag_cursor + 5)
                    name, tag_cursor = read_string(data, tag_cursor + 17)
                    tags.append(SourceTag(name, start, end, direction, repeat))
            cursor += chunk_size
        if cursor != frame_end or cel_count != 1:
            raise ValueError(f"Unexpected frame structure at {frame_index}")
        alpha = canvas.getchannel("A")
        if alpha.getbbox() is None:
            raise ValueError(f"Frame {frame_index} is unexpectedly empty")
        if alpha.getextrema()[0] == 255:
            raise ValueError(f"Frame {frame_index} has an opaque background")
        frames.append(canvas)
        offset = frame_end

    if offset != len(data) or layer_count != 1 or len(tags) != EXPECTED_TAGS:
        raise ValueError(f"Unexpected source structure: {layer_count} layers, {len(tags)} tags")
    for tag in tags:
        if tag.start > tag.end or tag.end >= frame_count or tag.direction not in (0, 1, 2, 3):
            raise ValueError(f"Invalid source tag: {tag}")
    return frames, durations, tags


def validate_supplied_atlas(supplied: Image.Image, frames: list[Image.Image]) -> None:
    if supplied.mode != "RGBA" or supplied.size != (320, 2944):
        raise ValueError(f"Unexpected supplied atlas: {supplied.mode} {supplied.size}")
    occupied: list[Image.Image] = []
    columns = supplied.width // FRAME_SIZE
    for index in range(columns * (supplied.height // FRAME_SIZE)):
        x = index % columns * FRAME_SIZE
        y = index // columns * FRAME_SIZE
        tile = supplied.crop((x, y, x + FRAME_SIZE, y + FRAME_SIZE))
        if tile.getchannel("A").getbbox() is not None:
            occupied.append(tile)
    if len(occupied) != len(frames):
        raise ValueError(f"Supplied atlas has {len(occupied)} non-empty cells, expected {len(frames)}")
    mismatches = [index for index, (source, exported) in enumerate(zip(frames, occupied)) if ImageChops.difference(source, exported).getbbox()]
    if mismatches:
        raise ValueError(f"Supplied atlas differs from Aseprite frames: {mismatches[:8]}")


def exact_source_tag(tags: list[SourceTag], animation: CuratedAnimation) -> SourceTag:
    matches = [tag for tag in tags if tag.name == animation.source_tag and tag.start == animation.start and tag.end == animation.end]
    if len(matches) != 1:
        raise ValueError(f"Curated animation no longer matches one source tag: {animation}")
    return matches[0]


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    return output.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_outputs() -> dict[Path, bytes]:
    if not SOURCE_ARCHIVE.is_file():
        raise FileNotFoundError(f"Missing source archive: {SOURCE_ARCHIVE}")
    with ZipFile(SOURCE_ARCHIVE) as archive:
        names = set(archive.namelist())
        if SOURCE_ASEPRITE not in names or SOURCE_ATLAS not in names:
            raise ValueError("Canonical Grey White source files are missing from the archive")
        source_aseprite = archive.read(SOURCE_ASEPRITE)
        supplied_atlas_bytes = archive.read(SOURCE_ATLAS)
    source_frames, durations, tags = decode_source(source_aseprite)
    supplied_atlas = Image.open(io.BytesIO(supplied_atlas_bytes)).convert("RGBA")
    validate_supplied_atlas(supplied_atlas, source_frames)

    source_atlas_rows = math.ceil(len(source_frames) / ATLAS_COLUMNS)
    source_atlas = Image.new("RGBA", (ATLAS_COLUMNS * FRAME_SIZE, source_atlas_rows * FRAME_SIZE), (0, 0, 0, 0))
    for source_index, source_frame in enumerate(source_frames):
        source_atlas.paste(source_frame, (
            source_index % ATLAS_COLUMNS * FRAME_SIZE,
            source_index // ATLAS_COLUMNS * FRAME_SIZE,
        ))
    source_atlas_bytes = png_bytes(source_atlas)

    selected_tags = [exact_source_tag(tags, animation) for animation in CURATED]
    selected_source_frames = sorted({index for animation in CURATED for index in range(animation.start, animation.end + 1)})
    source_to_atlas = {source_index: atlas_index for atlas_index, source_index in enumerate(selected_source_frames)}
    atlas_rows = math.ceil(len(selected_source_frames) / ATLAS_COLUMNS)
    runtime_atlas = Image.new("RGBA", (ATLAS_COLUMNS * FRAME_SIZE, atlas_rows * FRAME_SIZE), (0, 0, 0, 0))
    for source_index, atlas_index in source_to_atlas.items():
        x = atlas_index % ATLAS_COLUMNS * FRAME_SIZE
        y = atlas_index // ATLAS_COLUMNS * FRAME_SIZE
        runtime_atlas.paste(source_frames[source_index], (x, y))
    runtime_atlas_bytes = png_bytes(runtime_atlas)

    direction_names = ("forward", "reverse", "ping-pong", "ping-pong-reverse")
    animations = []
    for animation, source_tag in zip(CURATED, selected_tags):
        source_indices = list(range(animation.start, animation.end + 1))
        if source_tag.direction == 1:
            source_indices.reverse()
        frame_entries = []
        for source_index in source_indices:
            atlas_index = source_to_atlas[source_index]
            frame_entries.append({
                "index": atlas_index,
                "source_frame": source_index,
                "x": atlas_index % ATLAS_COLUMNS * FRAME_SIZE,
                "y": atlas_index // ATLAS_COLUMNS * FRAME_SIZE,
                "duration_ms": durations[source_index],
            })
        animations.append({
            "id": animation.id,
            "source_tag": source_tag.name,
            "source_range": [source_tag.start, source_tag.end],
            "source_direction": direction_names[source_tag.direction],
            "source_repeat": source_tag.repeat,
            "frames": frame_entries,
            "loop": animation.loop,
            "total_duration_ms": sum(frame["duration_ms"] for frame in frame_entries),
            "baseline_y": 31,
            "anchor": {"x": 16, "y": 31},
            "facing": "right",
            "cancellable": True,
            "roles": list(animation.roles),
        })

    metadata = {
        "format_version": 2,
        "source": {
            "archive": SOURCE_ARCHIVE.name,
            "asset": "Cat_Grey_White.aseprite",
            "sha256": sha256(source_aseprite),
            "frame_count": len(source_frames),
            "tag_count": len(tags),
            "frame_size": {"width": FRAME_SIZE, "height": FRAME_SIZE},
        },
        "atlas": {
            "path": "assets/cat_grey_white.png",
            "width": runtime_atlas.width,
            "height": runtime_atlas.height,
            "frame_width": FRAME_SIZE,
            "frame_height": FRAME_SIZE,
            "columns": ATLAS_COLUMNS,
            "frames": len(selected_source_frames),
            "decoded_bytes": runtime_atlas.width * runtime_atlas.height * 4,
            "image_rendering": "pixelated",
        },
        "animations": animations,
    }
    metadata_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    source_tags = {
        "source": "Cat_Grey_White.aseprite",
        "frame_count": len(source_frames),
        "atlas": {
            "path": "source-atlas.png",
            "width": source_atlas.width,
            "height": source_atlas.height,
            "columns": ATLAS_COLUMNS,
            "frame_width": FRAME_SIZE,
            "frame_height": FRAME_SIZE,
        },
        "frame_durations_ms": durations,
        "tags": [{
            "name": tag.name,
            "from": tag.start,
            "to": tag.end,
            "direction": direction_names[tag.direction],
            "repeat": tag.repeat,
            "frame_count": tag.end - tag.start + 1,
            "total_duration_ms": sum(durations[tag.start:tag.end + 1]),
            "frames": [{
                "index": frame_index,
                "x": frame_index % ATLAS_COLUMNS * FRAME_SIZE,
                "y": frame_index // ATLAS_COLUMNS * FRAME_SIZE,
                "duration_ms": durations[frame_index],
            } for frame_index in range(tag.start, tag.end + 1)],
        } for tag in tags],
    }
    source_tags_bytes = (json.dumps(source_tags, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    row_height = 76
    sheet = Image.new("RGBA", (960, 34 + row_height * len(animations)), (19, 20, 24, 255))
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 10), "Vast Cat Addon - Cat_Grey_White curated animation contact sheet", fill=(245, 245, 243, 255))
    for row, animation in enumerate(animations):
        top = 34 + row * row_height
        draw.rectangle((0, top, sheet.width, top + row_height - 1), fill=(27 if row % 2 == 0 else 23,) * 3 + (255,))
        label = f"{animation['id']}  <-  {animation['source_tag']} {animation['source_range']}  | {len(animation['frames'])}f / {animation['total_duration_ms']}ms / {animation['loop']}  | baseline 31"
        draw.text((10, top + 4), label, fill=(220, 222, 228, 255))
        entries = animation["frames"]
        if len(entries) > 10:
            positions = sorted({round(index * (len(entries) - 1) / 9) for index in range(10)})
            entries = [entries[index] for index in positions]
        for column, frame in enumerate(entries):
            sprite = source_frames[frame["source_frame"]].resize((48, 48), Image.Resampling.NEAREST)
            x = 10 + column * 58
            y = top + 24
            sheet.alpha_composite(sprite, (x, y))
            draw.line((x, y + 46, x + 47, y + 46), fill=(120, 83, 180, 180))
    contact_sheet_bytes = png_bytes(sheet)

    manifest = {
        "id": "com.vast.cat-addon",
        "name": "Cat Addon",
        "version": BUNDLE_VERSION,
        "api_version": 2,
        "minimum_vast_version": "0.1.4",
        "canonical_character": "Cat_Grey_White",
        "license_status": "unverified-release-blocker",
        "animations": {
            "path": "animations/animations.json",
            "size": len(metadata_bytes),
            "sha256": sha256(metadata_bytes),
        },
        "assets": [{
            "path": "assets/cat_grey_white.png",
            "role": "runtime-atlas",
            "mime_type": "image/png",
            "width": runtime_atlas.width,
            "height": runtime_atlas.height,
            "frame_width": FRAME_SIZE,
            "frame_height": FRAME_SIZE,
            "frames": len(selected_source_frames),
            "size": len(runtime_atlas_bytes),
            "sha256": sha256(runtime_atlas_bytes),
        }],
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return {
        PACKAGE_ROOT / "assets" / "cat_grey_white.png": runtime_atlas_bytes,
        PACKAGE_ROOT / "animations" / "animations.json": metadata_bytes,
        PACKAGE_ROOT / "manifest.json": manifest_bytes,
        GENERATED_ROOT / "source-tags.json": source_tags_bytes,
        GENERATED_ROOT / "source-atlas.png": source_atlas_bytes,
        GENERATED_ROOT / "contact-sheet.png": contact_sheet_bytes,
    }


def write_outputs(outputs: dict[Path, bytes], check: bool) -> None:
    stale = []
    for path, data in outputs.items():
        if not path.is_file() or path.read_bytes() != data:
            stale.append(path.relative_to(ROOT).as_posix())
    if check:
        if stale:
            raise SystemExit("Stale Cat Addon generated assets:\n" + "\n".join(stale) + "\nRun: npm run cat-addon:assets")
        print(f"Cat assets verified: {EXPECTED_FRAMES} source frames, {EXPECTED_TAGS} tags, {len(CURATED)} curated animations")
        return
    for path, data in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            handle.write(data)
            temporary = Path(handle.name)
        temporary.replace(path)
    print(f"Generated {len(outputs)} Cat Addon artifacts from {SOURCE_ASEPRITE}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify committed generated outputs")
    args = parser.parse_args()
    write_outputs(build_outputs(), args.check)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Cat asset build failed: {error}", file=sys.stderr)
        raise
