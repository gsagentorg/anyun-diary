#!/usr/bin/env bash
# to-opus.sh — 把 ${AUDIO_ROOT}/已打标签 全部音频转 64kbps opus → static/audio/
set -euo pipefail
if [ -z "${AUDIO_ROOT:-}" ]; then
  echo "错误: 需要设置 AUDIO_ROOT 环境变量（指向切片素材目录）" >&2
  exit 1
fi
SRC="${AUDIO_ROOT}/已打标签"
DST="$(cd "$(dirname "$0")/.." && pwd)/static/audio"
mkdir -p "$DST"
n=0; total=$(ls "$SRC" | wc -l)
for f in "$SRC"/*; do
  base=$(basename "$f")
  ext="${base##*.}"
  out="$DST/${base%.*}.opus"
  [ -s "$out" ] && { echo "skip $base"; continue; }
  ffmpeg -y -v error -i "$f" -c:a libopus -b:a 64k -application audio "$out"
  n=$((n+1)); echo "[$n/$total] $base"
done
echo "done: $n transcoded → $DST"
