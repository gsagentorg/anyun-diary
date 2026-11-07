#!/usr/bin/env python3
"""Update only lyrics for clips already present in data.json.

Input: TAGGED_DIR/<existing clip stem>.lrc (or AUDIO_ROOT/已打标签).
No source directory enumeration, media probing or project sidecar reads.
The existing data.json is the catalog; non-lyric fields are preserved.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

TS_RE = re.compile(r"\[(\d{1,2}):(\d{2})\.(\d{2,3})\]")
OFFSET_RE = re.compile(r"^\[offset:\s*([+-]?\d+)\s*\]$", re.IGNORECASE)
META_RE = re.compile(r"^\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]$")


def parse_lrc_text(text):
    items = []
    offset_ms = 0
    for number, raw in enumerate(text.lstrip("﻿").splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        offset = OFFSET_RE.fullmatch(line)
        if offset:
            offset_ms += int(offset.group(1))
            continue
        stamps = list(TS_RE.finditer(line))
        if not stamps:
            if META_RE.fullmatch(line):
                continue
            raise ValueError(f"line {number}: unsupported LRC syntax")
        if any(int(match[2]) >= 60 for match in stamps):
            raise ValueError(f"line {number}: seconds must be below 60")
        lyric = TS_RE.sub("", line).strip()
        if not lyric:
            continue
        for match in stamps:
            mm, ss, frac = match.groups()
            items.append({"t": int(mm) * 60 + int(ss) + int(frac) / 10 ** len(frac),
                          "text": lyric})
    for item in items:
        item["t"] = round(item["t"] - offset_ms / 1000, 3)
    if not items:
        raise ValueError("empty or unparseable lyrics; existing data not changed")
    if any(item["t"] < 0 for item in items):
        raise ValueError("negative lyric timestamp")
    # Equal timestamps are valid (simultaneous/duet lines; owner 2026-11-07:
    # panel flashes through them, metadata pushes only the first).
    if any(b["t"] < a["t"] for a, b in zip(items, items[1:])):
        raise ValueError("lyric timestamps must be non-decreasing")
    return items


def parse_lrc(path):
    return parse_lrc_text(Path(path).read_text(encoding="utf-8-sig"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def refresh_lyrics(data_path, tagged_dir, *, dry_run=False):
    data_path = Path(data_path)
    if data_path.is_symlink():
        raise ValueError("data output must not be a symlink")
    original = data_path.read_bytes()
    before = json.loads(original)
    after = copy.deepcopy(before)
    root = Path(tagged_dir).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("TAGGED_DIR must be a directory")
    sources = {}
    clips = changed = rows = trailing = 0
    for recording in after["recordings"]:
        for clip in recording.get("clips", []):
            name = clip["file"]
            if not isinstance(name, str) or not name or Path(name).name != name or name in (".", "..") or chr(92) in name:
                raise ValueError("clip filename must be a plain basename")
            source = root / (Path(name).stem + ".lrc")
            if source.resolve(strict=True).parent != root:
                raise ValueError("lyric symlink escapes TAGGED_DIR")
            content = source.read_bytes()
            expected = sources.setdefault(source, digest(content))
            if expected != digest(content):
                raise RuntimeError("lyric source changed during rebuild")
            lyrics = parse_lrc_text(content.decode("utf-8-sig"))
            duration = clip["offsetEnd"] - clip["offsetStart"]
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError(f"invalid clip duration: {name}")
            # Whole-second rounding can trail ≤0.5s past the cut; such lines are inert
            # (never highlighted) and kept verbatim. A lrc that STARTS beyond the clip
            # is treated as the wrong file (owner data 2026-11-07: 27/238 trailing ≤0.5s).
            if lyrics[0]["t"] > duration + 0.05:
                raise ValueError(f"lyrics start beyond clip end (wrong clip?): {name}")
            trailing += sum(1 for x in lyrics if x["t"] > duration + 0.05)
            changed += clip.get("lyrics", []) != lyrics
            clip["lyrics"] = lyrics
            clips += 1
            rows += len(lyrics)
    if not clips:
        raise ValueError("baseline has no clips")
    for path, expected in sources.items():
        if digest(path.read_bytes()) != expected:
            raise RuntimeError("lyric source changed during rebuild")
    if data_path.read_bytes() != original:
        raise RuntimeError("data.json changed concurrently; refusing overwrite")
    if changed and not dry_run:
        after["generatedAt"] = int(time.time())
        payload = json.dumps(after, ensure_ascii=False, indent=1).encode("utf-8")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=data_path.parent, prefix=".data-", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.chmod(data_path.stat().st_mode & 0o777)
            if data_path.read_bytes() != original:
                raise RuntimeError("data.json changed concurrently; refusing overwrite")
            os.replace(temporary, data_path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"clips": clips, "changed_lyrics": changed, "lyric_rows": rows,
            "trailing_beyond_end_lines": trailing,
            "non_lyric_changes": 0, "written": bool(changed and not dry_run)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tagged-dir", help="directory containing final same-name LRCs")
    parser.add_argument("--data-file", type=Path,
                        default=Path(__file__).resolve().parent.parent / "src/lib/data.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    tagged = args.tagged_dir or os.environ.get("TAGGED_DIR", "").strip()
    if not tagged:
        legacy = os.environ.get("AUDIO_ROOT", "").strip()
        if legacy:
            tagged = str(Path(legacy) / "已打标签")
    if not tagged:
        parser.error("set TAGGED_DIR or --tagged-dir; existing data.json is required")
    try:
        summary = refresh_lyrics(args.data_file, tagged, dry_run=args.dry_run)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
