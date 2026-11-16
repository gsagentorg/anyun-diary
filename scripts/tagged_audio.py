"""Read-only tagged audio filename, metadata and LRC parsing."""
import json, os, re, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
