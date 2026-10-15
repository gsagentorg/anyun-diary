import type { Recording, Track } from './types';
import { buildRecTracks } from './types';

/**
 * 把 [lo, hi)（epoch 秒，含 lo 不含 hi）内的录像按开播时间排序、
 * 每场录像内部按切片顺序，串成一个播放列表。
 * lo/hi 传 undefined 表示那一侧不限制。
 *
 * 纯函数（不含 runes），可直接被服务端路由复用。
 */
export function tracksInRange(recs: Recording[], lo?: number, hi?: number): Track[] {
  const picked = recs
    .filter((r) => (lo == null || r.start >= lo) && (hi == null || r.start < hi))
    .sort((a, b) => a.start - b.start);
  return picked.flatMap((r) => buildRecTracks(r));
}

/** yyyy-mm-dd（Asia/Shanghai 当日 0 点）的 epoch 秒 */
export function dayStartOf(dateStr: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const t = Date.parse(`${dateStr}T00:00:00+08:00`) / 1000;
  return Number.isFinite(t) ? t : null;
}

/** 「from/to 都是合法 yyyy-mm-dd 且 from<=to」 */
export function validRange(from: string, to: string): boolean {
  const a = dayStartOf(from), b = dayStartOf(to);
  return a != null && b != null && a <= b;
}

/** XML 转义 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 绝对音频 URL */
export const trackUrl = (t: Track, base: string) =>
  `${base}/audio/${encodeURIComponent(t.clip.opus)}`;

/**
 * XSPF（.xspf）：显式逐曲列表，带 title/duration。
 * 语义无歧义——播放器会当作「曲目列表」，不会误会成 HLS 分片。
 */
export function buildXspf(tracks: Track[], base: string, plName: string): string {
  const items = tracks
    .map((t) => {
      const ms = Math.max(0, Math.round((t.clip.offsetEnd - t.clip.offsetStart) * 1000));
      return [
        '    <track>',
        `      <location>${esc(trackUrl(t, base))}</location>`,
        `      <title>${esc(t.clip.title || '（未识别）')}</title>`,
        `      <duration>${ms}</duration>`,
        '    </track>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${esc(plName)}</title>`,
    '  <trackList>',
    items,
    '  </trackList>',
    '</playlist>',
    '',
  ].join('\n');
}

/** PLS（.pls）：INI 式逐曲列表，兼容性最广的老牌格式 */
export function buildPls(tracks: Track[], base: string, plName: string): string {
  const lines = ['[playlist]'];
  tracks.forEach((t, i) => {
    const n = i + 1;
    lines.push(`File${n}=${trackUrl(t, base)}`);
    lines.push(`Title${n}=${t.clip.title || '（未识别）'}`);
    lines.push(`Length${n}=${Math.max(0, Math.round(t.clip.offsetEnd - t.clip.offsetStart))}`);
  });
  lines.push(`NumberOfEntries=${tracks.length}`, 'Version=2');
  return lines.join('\n') + '\n';
}

/** 生成 m3u 文本：绝对 URL 指向 opus 文件（外部播放器用）。
 * base 传站点 origin（如 https://anyun-diary.public.bcw2.top:3004）。
 */
export function buildM3u(tracks: Track[], base: string, plName: string): string {
  const lines = ['#EXTM3U', '#PLAYLIST:' + plName];
  for (const t of tracks) {
    const dur = Math.max(0, Math.round(t.clip.offsetEnd - t.clip.offsetStart));
    lines.push(`#EXTINF:${dur},${t.clip.title || '（未识别）'}`);
    lines.push(`${base}/audio/${encodeURIComponent(t.clip.opus)}`);
  }
  return lines.join('\n') + '\n';
}

/** 规范化录像数组（补默认字段），服务端与页面共用 */
export function normalize(recs: Recording[]): Recording[] {
  return recs.map((r) => ({
    ...r,
    duration: r.duration ?? null,
    segments: r.segments ?? [],
    clips: r.clips ?? [],
  }));
}
