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

/** 展示层有效时间：数据层保留源值（owner 2026-11-07），超出切片尾部的行在展示层视为正好收在音频结尾。 */
function displayTime(t: number, limit: number): number {
  return t > limit ? limit : t;
}

/** 展示层歌词行下标：按「尾部超界行收在音频结尾」的折叠时间二分，最后一行 t' <= pos；无歌词/未开始 → -1。
 *  duration = 切片时长（offsetEnd-offsetStart）；不适用的调用方传 Infinity（行为与按源值一致）。 */
export function lyricDisplayIndexAt(
  lyrics: LyricLine[] | null | undefined,
  pos: number,
  duration: number = Infinity,
): number {
  if (!lyrics || lyrics.length === 0 || !Number.isFinite(pos)) return -1;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  if (pos < displayTime(lyrics[0].t, limit)) return -1;
  let lo = 0;
  let hi = lyrics.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (displayTime(lyrics[mid].t, limit) <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 同刻多行分组：idx 所在等值时间戳组的 [start,end]；无歌词/越界 → null。
 *  同刻行 = 合唱/同唱（面板整组快速闪过，元数据只推首行）；duration 传入切片时长时，
 *  尾部超界行同样折叠到结尾并互相成组（owner 2026-11-07）。 */
export function sameTimeGroupBounds(
  lyrics: LyricLine[] | null | undefined,
  idx: number,
  duration: number = Infinity,
): [number, number] | null {
  if (!lyrics || idx < 0 || idx >= lyrics.length) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const t = displayTime(lyrics[idx].t, limit);
  let start = idx;
  let last = idx;
  while (start > 0 && displayTime(lyrics[start - 1].t, limit) === t) start--;
  while (last + 1 < lyrics.length && displayTime(lyrics[last + 1].t, limit) === t) last++;
  return [start, last];
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
