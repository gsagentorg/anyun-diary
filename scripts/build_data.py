#!/usr/bin/env python3
"""build_data.py — 从素材目录自动生成前端数据。
输入: <AUDIO_ROOT>/{主录像, *-proj.llc, 已打标签/}
输出: ../../static/data.json （时间轴 + 切片 + 歌名 + opus 引用）

文件名约定（自动推导，不手填）:
  主录像:  "YYYY-MM-DD HH-MM-SS.mp4|.mkv" → 开播本地时间(Asia/Shanghai)
  llc:     "<录像名>-proj.llc" → cutSegments[start,end](录像内相对秒)
  切片:    "<录像名>-<HH.MM.SS.mmm>-<HH.MM.SSS.mmm>-segN.m4a|.ogg"
           → 时间戳即录像内偏移（与 llc 一致，交叉验证）
歌名: 切片文件自带的元数据（不依赖任何外部打标产物）
  m4a → format_tags.title ; ogg → stream_tags.TITLE
  生成期可用 SONG_FMT 环境变量套模板（占位符 {title}{artist}），默认 {title} 与原样一致
"""
import json, os, re, sys, subprocess, datetime as dt

BASE = os.environ.get("AUDIO_ROOT", "").strip()
if not BASE:
    sys.exit("需要设置 AUDIO_ROOT 环境变量（指向切片素材目录）")
SONG_FMT = os.environ.get("SONG_FMT", "{title}")
TZ = dt.timezone(dt.timedelta(hours=8))

SEG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"(?:-(seg\d+))?\.(m4a|ogg)$"
)

def hms_ms(a, b, c, d):
    return int(a) * 3600 + int(b) * 60 + int(c) + int(d) / 1000.0

def read_tags(path):
    """读切片文件自带的 title/artist 标签，返回 (title, artist)。
    m4a → format_tags；ogg(Opus) → stream_tags（ffprobe 版本不同大小写不一：title/TITLE、artist/ARTIST 均兼容）。
    """
    title = artist = ""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format_tags:stream_tags",
             "-of", "json", path],
            capture_output=True, text=True, timeout=15
        ).stdout
        j = json.loads(out or "{}")
        def pick(tags, keys):
            if not isinstance(tags, dict):
                return None
            for k in keys:
                v = tags.get(k)
                if v and str(v).strip():
                    return str(v).strip()
            return None
        sources = [((j.get("format", {}) or {}).get("tags"))]
        for st in j.get("streams", []) or []:
            sources.append((st or {}).get("tags"))
        for tags in sources:
            if not title:
                title = pick(tags, ("title", "TITLE")) or ""
            if not artist:
                artist = pick(tags, ("artist", "ARTIST")) or ""
            if title and artist:
                break
    except Exception as e:
        print(f"WARN: 读标签失败 {os.path.basename(path)}: {e}", file=sys.stderr)
    return title, artist

def fmt_title(tag_title, tag_artist):
    """按 SONG_FMT 模板生成歌名；模板渲染为空则回退原始 title 标签。默认 {title} 与未设 env 完全一致。"""
    s = SONG_FMT.replace("{title}", tag_title or "").replace("{artist}", tag_artist or "").strip()
    return s or (tag_title or "")

def main():

    # 主录像: 建索引（录像名(不含扩展名) → 视频文件名），供骨架种子 + 时长增强用
    videoByName = {}
    for f in sorted(os.listdir(BASE)):
        m = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})\.(mp4|mkv)$", f)
        if not m:
            continue
        videoByName[m.group(1)] = f

    # 主录像索引同时作为骨架种子: 无切片的录像仍保留在输出中；
    # 有切片但主录像缺失的录像由切片扫描补建（不再丢弃）
    recs = {}
    for name in videoByName:
        start = dt.datetime.strptime(name[:11] + name[11:].replace('-', ':'), "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
        recs[name] = {"file": name, "start": int(start.timestamp()), "duration": None}

    # 已打标签: 切片文件 → 归并进骨架（rec_name 无录像时补建）
    tagged_dir = os.path.join(BASE, "已打标签")
    for f in sorted(os.listdir(tagged_dir)):
        m = SEG_RE.match(f)
        if not m:
            print(f"WARN: 无法解析切片名: {f}", file=sys.stderr)
            continue
        rec_name = m.group(1)
        if rec_name not in recs:
            start = dt.datetime.strptime(rec_name[:11] + rec_name[11:].replace('-', ':'), "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
            recs[rec_name] = {"file": rec_name, "start": int(start.timestamp()), "duration": None}
        off_start = hms_ms(m.group(2), m.group(3), m.group(4), m.group(5))
        off_end = hms_ms(m.group(6), m.group(7), m.group(8), m.group(9))
        seg_no = m.group(10)
        tag_title, tag_artist = read_tags(os.path.join(tagged_dir, f))
        title = fmt_title(tag_title, tag_artist)
        recs[rec_name].setdefault("clips", []).append({
            "file": f,
            "opus": f"{os.path.splitext(f)[0]}.opus",
            "offsetStart": round(off_start, 3),
            "offsetEnd": round(off_end, 3),
            "seg": seg_no,
            "title": title,
        })

    # llc: 切片段（按录像名直接匹配骨架 key）
    for f in sorted(os.listdir(BASE)):
        m = re.match(r"^(.*)-proj\.llc$", f)
        if not m:
            continue
        key = m.group(1)
        if key not in recs:
            print(f"WARN: llc 无对应录像: {f}", file=sys.stderr)
            continue
        rec = recs[key]
        rec["segments"] = []
        txt = open(os.path.join(BASE, f), encoding="utf-8").read()
        for sm in re.finditer(r"start:\s*([\d.]+),\s*end:\s*([\d.]+)", txt):
            rec["segments"].append({"start": float(sm.group(1)), "end": float(sm.group(2))})

    # 录像时长（若 ffprobe 结果缓存存在则读入；无对应主录像则留空由前端标"未知"）
    dur_path = os.path.join(os.path.dirname(__file__), "durations.json")
    durs = json.load(open(dur_path)) if os.path.exists(dur_path) else {}
    for k, r in recs.items():
        video = videoByName.get(k)
        r["duration"] = durs.get(video) if video else None

    out = {
        "generatedAt": int(dt.datetime.now(TZ).timestamp()),
        "timezone": "Asia/Shanghai",
        "recordings": [recs[k] for k in sorted(recs)],
    }
    dest = os.path.join(os.path.dirname(__file__), "..", "src", "lib", "data.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    n_rec = len(out["recordings"])
    n_clips = sum(len(r.get("clips", [])) for r in out["recordings"])
    n_segs = sum(len(r.get("segments", [])) for r in out["recordings"])
    print(f"OK: {n_rec} 录像, {n_segs} llc 段, {n_clips} 切片 → {os.path.abspath(dest)}")

if __name__ == "__main__":
    main()
