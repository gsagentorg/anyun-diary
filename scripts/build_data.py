#!/usr/bin/env python3
"""build_data.py — 从 NAS 目录自动生成前端数据。
输入: /mnt/Share/安允日记/{主录像, *-proj.llc, 已打标签/}
输出: ../../static/data.json （时间轴 + 切片 + 歌名 + opus 引用）

文件名约定（自动推导，不手填）:
  主录像:  "YYYY-MM-DD HH-MM-SS.mp4|.mkv" → 开播本地时间(Asia/Shanghai)
  llc:     "<录像名>-proj.llc" → cutSegments[start,end](录像内相对秒)
  切片:    "<录像名>-<HH.MM.SS.mmm>-<HH.MM.SSS.mmm>-segN.m4a|.ogg"
           → 时间戳即录像内偏移（与 llc 一致，交叉验证）
歌名/识别来源: /var/tmp/songid/tag_state.json (title/source)
"""
import json, os, re, sys, datetime as dt

BASE = "/mnt/Share/安允日记"
TAG_STATE = "/var/tmp/songid/tag_state.json"
TZ = dt.timezone(dt.timedelta(hours=8))

SEG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"-(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})"
    r"-(seg\d+)\.(m4a|ogg)$"
)

def hms_ms(a, b, c, d):
    return int(a) * 3600 + int(b) * 60 + int(c) + int(d) / 1000.0

def main():
    tags = json.load(open(TAG_STATE))

    # 主录像: 名称 → 开播时间 + 时长
    recs = {}
    for f in sorted(os.listdir(BASE)):
        m = re.match(r"^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2})\.(mp4|mkv)$", f)
        if not m:
            continue
        name = m.group(0)
        start = dt.datetime.strptime(f"{m.group(1)} {m.group(2).replace('-', ':')}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)
        recs[name] = {"file": name, "start": int(start.timestamp()), "duration": None}

    # llc: 切片段
    for f in sorted(os.listdir(BASE)):
        m = re.match(r"^(.*)-proj\.llc$", f)
        if not m:
            continue
        key = m.group(1)
        # llc 的 key 是录像名（不含扩展名）；找到对应录像
        matches = [k for k in recs if k.rsplit('.', 1)[0] == key]
        if not matches:
            print(f"WARN: llc 无对应录像: {f}", file=sys.stderr)
            continue
        rec = recs[matches[0]]
        rec["segments"] = []
        txt = open(os.path.join(BASE, f), encoding="utf-8").read()
        for sm in re.finditer(r"start:\s*([\d.]+),\s*end:\s*([\d.]+)", txt):
            rec["segments"].append({"start": float(sm.group(1)), "end": float(sm.group(2))})

    # 已打标签: 切片文件
    tagged_dir = os.path.join(BASE, "已打标签")
    for f in sorted(os.listdir(tagged_dir)):
        m = SEG_RE.match(f)
        if not m:
            print(f"WARN: 无法解析切片名: {f}", file=sys.stderr)
            continue
        rec_name = m.group(1)
        off_start = hms_ms(m.group(2), m.group(3), m.group(4), m.group(5))
        off_end = hms_ms(m.group(6), m.group(7), m.group(8), m.group(9))
        seg_no = m.group(10)
        ext = m.group(11)
        info = tags.get(f, {})
        matches = [k for k in recs if k.rsplit('.', 1)[0] == rec_name]
        if not matches:
            print(f"WARN: 切片无对应录像: {f}", file=sys.stderr)
            continue
        recs[matches[0]].setdefault("clips", []).append({
            "file": f,
            "opus": f"{os.path.splitext(f)[0]}.opus",
            "offsetStart": round(off_start, 3),
            "offsetEnd": round(off_end, 3),
            "seg": seg_no,
            "title": info.get("title") or "",
            "source": info.get("source") or "",
        })

    # 录像时长（若 ffprobe 结果缓存存在则读入；否则留空由前端标"未知"）
    dur_path = os.path.join(os.path.dirname(__file__), "durations.json")
    durs = json.load(open(dur_path)) if os.path.exists(dur_path) else {}
    for k, r in recs.items():
        r["duration"] = durs.get(k["file"] if isinstance(k, dict) else k)

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
