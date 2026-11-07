#!/usr/bin/env python3
"""Update only lyrics for clips already present in data.json.

Input: TAGGED_DIR/<existing clip stem>.lrc (or AUDIO_ROOT/已打标签).
No source directory enumeration, media probing or project sidecar reads.
The existing data.json is the catalog; non-lyric fields are preserved.
"""
import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
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


SEG_NAME_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"(?:-(seg\d+))?\.(m4a|ogg)$"
)


def hms_ms(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def read_tags(path):
    """切片自带的 title/artist 标签（ffprobe，仅读已打标签内的切片音频）；失败返回 ('','')。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format_tags:stream_tags",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=15
        ).stdout
        j = json.loads(out or "{}")
    except Exception:
        return "", ""

    def pick(tags, keys):
        if not isinstance(tags, dict):
            return None
        for k in keys:
            v = tags.get(k)
            if v and str(v).strip():
                return str(v).strip()
        return None

    title = artist = ""
    sources = [((j.get("format", {}) or {}).get("tags"))]
    for st in j.get("streams", []) or []:
        sources.append((st or {}).get("tags"))
    for tags in sources:
        title = title or pick(tags, ("title", "TITLE")) or ""
        artist = artist or pick(tags, ("artist", "ARTIST")) or ""
        if title and artist:
            break
    return title, artist


def apply_song_fmt(title, artist):
    fmt = os.environ.get("SONG_FMT", "{title}")
    s = fmt.replace("{title}", title or "").replace("{artist}", artist or "").strip()
    return s or (title or "")


def catalog_epoch_ms_of(rec_name):
    """录像名 → 开播本地时间（Asia/Shanghai）epoch 秒，与入库数据一致。"""
    start = datetime.strptime(rec_name[:11] + rec_name[11:].replace('-', ':'),
                              "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone(timedelta(hours=8)))
    return int(start.timestamp())


def expand_catalog(data_path, tagged_dir, *, dry_run=False):
    """吸收已打标签中新出现的切片音频（明确授权的目录扩容）：
    只增不删，既有条目字段不动；切片名承载起止偏移，标题读切片自带 tag，
    同名 lrc 存在则按同一套规则解析（同刻允许、倒序拒绝、首行超界=拿错文件拒绝）。"""
    data_path = Path(data_path)
    if data_path.is_symlink():
        raise ValueError("data output must not be a symlink")
    original = data_path.read_bytes()
    after = copy.deepcopy(json.loads(original))
    root = Path(tagged_dir).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("TAGGED_DIR must be a directory")
    existing_stems = {Path(c["file"]).stem
                      for rec in after["recordings"]
                      for c in rec.get("clips", [])}
    recordings_by_name = {rec["file"]: rec for rec in after["recordings"]}
    tracked = {}

    def digest_path(p):
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()

    candidates = []
    skipped_non_segment = 0
    for path in sorted(root.iterdir()):
        if path.suffix.lower() not in (".m4a", ".ogg"):
            continue
        m = SEG_NAME_RE.match(path.name)
        if not m:
            skipped_non_segment += 1
            continue
        if path.stem in existing_stems:
            continue
        candidates.append((path, m))

    additions = {}
    clips_added = without_lyrics = trailing = probed_empty = 0
    for path, m in candidates:
        rec_name = m.group(1)
        lrc_path = root / (path.stem + ".lrc")
        lyrics = None
        if lrc_path.exists():
            tracked[lrc_path] = digest_path(lrc_path)
            lyrics = parse_lrc_text(lrc_path.read_text(encoding="utf-8-sig"))
        tracked[path] = digest_path(path)
        start_off = hms_ms(m.group(2), m.group(3), m.group(4), m.group(5))
        end_off = hms_ms(m.group(6), m.group(7), m.group(8), m.group(9))
        if end_off <= start_off:
            raise ValueError(f"non-positive clip span: {path.name}")
        if lyrics is not None:
            if lyrics[0]["t"] > (end_off - start_off) + 0.05:
                raise ValueError(f"lyrics start beyond clip end (wrong clip?): {path.name}")
            trailing += sum(1 for x in lyrics if x["t"] > (end_off - start_off) + 0.05)
        title, artist = read_tags(path)
        if not title and not artist:
            probed_empty += 1
        clip = {
            "file": path.name,
            "opus": path.stem + ".opus",
            "offsetStart": round(start_off, 3),
            "offsetEnd": round(end_off, 3),
            "seg": m.group(10),
            "title": apply_song_fmt(title, artist),
        }
        if lyrics is not None:
            clip["lyrics"] = lyrics
        else:
            without_lyrics += 1
        additions.setdefault(rec_name, []).append(clip)
        clips_added += 1

    for rec_name, clips in additions.items():
        if rec_name in recordings_by_name:
            rec = recordings_by_name[rec_name]
            rec["clips"] = sorted(rec.get("clips", []) + clips, key=lambda c: c["file"])
        else:
            after["recordings"].append({
                "file": rec_name,
                "start": catalog_epoch_ms_of(rec_name),
                "duration": None,
                "clips": sorted(clips, key=lambda c: c["file"]),
            })
    after["recordings"].sort(key=lambda r: r["file"])

    for p, expect in tracked.items():
        if digest_path(p) != expect:
            raise RuntimeError("source changed during catalog expansion")
    if data_path.read_bytes() != original:
        raise RuntimeError("data.json changed concurrently; refusing overwrite")
    if not candidates:
        return {"scanned_new_segments": 0, "recordings_added": 0, "clips_added": 0,
                "recordings_total": len(after["recordings"]), "clips_total": sum(len(r.get("clips", [])) for r in after["recordings"]),
                "clips_without_lyrics": without_lyrics, "trailing_beyond_end_lines": trailing,
                "probed_empty_tags": probed_empty, "skipped_non_segment_audio": skipped_non_segment,
                "non_existing_entry_changes": 0, "written": False}
    if not dry_run:
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
    return {"scanned_new_segments": clips_added, "recordings_added": sum(1 for n in additions if n not in recordings_by_name),
            "clips_added": clips_added,
            "recordings_total": len(after["recordings"]), "clips_total": sum(len(r.get("clips", [])) for r in after["recordings"]),
            "clips_without_lyrics": without_lyrics, "trailing_beyond_end_lines": trailing,
            "probed_empty_tags": probed_empty, "skipped_non_segment_audio": skipped_non_segment,
            "non_existing_entry_changes": 0, "written": bool(not dry_run and clips_added > 0)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tagged-dir", help="directory containing final same-name LRCs")
    parser.add_argument("--data-file", type=Path,
                        default=Path(__file__).resolve().parent.parent / "src/lib/data.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--expand-catalog", action="store_true",
                        help="吸收已打标签中新切片音频到 data.json（明确授权的扩容操作）")
    args = parser.parse_args(argv)
    tagged = args.tagged_dir or os.environ.get("TAGGED_DIR", "").strip()
    if not tagged:
        legacy = os.environ.get("AUDIO_ROOT", "").strip()
        if legacy:
            tagged = str(Path(legacy) / "已打标签")
    if not tagged:
        parser.error("set TAGGED_DIR or --tagged-dir; existing data.json is required")
    try:
        if args.expand_catalog:
            summary = expand_catalog(args.data_file, tagged, dry_run=args.dry_run)
        else:
            summary = refresh_lyrics(args.data_file, tagged, dry_run=args.dry_run)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
