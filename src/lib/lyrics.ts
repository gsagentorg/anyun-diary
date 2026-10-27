import type { Clip, LyricLine } from './types';

/** 当前应显示的歌词行下标（最后一行 t <= pos），无歌词/未开始 → -1（二分） */
export function lyricIndexAt(lyrics: LyricLine[] | null | undefined, pos: number): number {
  if (!lyrics || lyrics.length === 0) return -1;
  if (!Number.isFinite(pos)) return -1;
  if (pos < lyrics[0].t) return -1;
  let lo = 0;
  let hi = lyrics.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].t <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 该切片有无歌词 */
export function hasLyrics(clip: Clip | null | undefined): boolean {
  return !!clip?.lyrics && clip.lyrics.length > 0;
}

/** FNV-1a 32bit → 8 位 hex */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 歌词指纹：每行 text 去首尾空白、折叠行内空白、join('\n') 后 fnv1a */
export function lyricsFingerprint(clip: Clip): string {
  const lines = (clip.lyrics ?? []).map((l) => l.text.trim().replace(/\s+/g, ' '));
  return fnv1a(lines.join('\n'));
}
