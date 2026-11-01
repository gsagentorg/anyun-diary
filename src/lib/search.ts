// 站内搜索：简单关键词 + GitHub 风格 字段:值 高级语法。纯函数（无 runes），可服务端复用。
// 字段：title 歌名 / lyrics 歌词 / time HH:MM 或 HH:MM-HH:MM / date MM-DD 或 YYYY-MM-DD。
// 裸关键词 = 歌名 ∪ 歌词 ∪ 日期文本 的子串匹配（大小写不敏感）；多条件空格分隔 = AND。
import type { Clip, Recording } from './types';
import { dayStartOf } from './playlist-core';

export type SearchToken = { kind: 'bare'; v: string } | { kind: 'field'; field: string; v: string };

export type SearchHit = {
  rec: Recording;
  clipIndex: number;
  clip: Clip;
  /** 命中的歌词行（有则展示摘要） */
  line: string | null;
};

export function parseQuery(q: string): SearchToken[] {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const m = /^([A-Za-z_]+):(.+)$/.exec(tok);
      if (m) return { kind: 'field' as const, field: m[1].toLowerCase(), v: m[2] };
      return { kind: 'bare' as const, v: tok.toLowerCase() };
    });
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** clip 绝对开始时刻的 Asia/Shanghai HH:MM 与日期 yyyy-mm-dd */
export function clipClock(rec: Recording, clip: Clip): { hm: string; date: string } {
  const d = new Date((rec.start + clip.offsetStart) * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { hm: `${get('hour')}:${get('minute')}`, date: `${get('year')}-${get('month')}-${get('day')}` };
}

function toMin(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function matchTime(tok: string, hm: string): boolean {
  const cur = toMin(hm);
  if (cur == null) return false;
  const range = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(tok.trim());
  if (range) {
    const a = toMin(range[1]);
    const b = toMin(range[2]);
    return a != null && b != null && cur >= a && cur <= b;
  }
  const one = toMin(tok);
  return one != null && one === cur;
}

function matchDate(tok: string, date: string): boolean {
  const t = tok.trim().replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t === date;
  if (/^\d{2}-\d{2}$/.test(t)) return date.endsWith('-' + t);
  return false;
}

export function searchClips(
  recs: Recording[],
  query: string,
  range?: { from?: string; to?: string },
): SearchHit[] {
  const tokens = parseQuery(query);
  if (tokens.length === 0) return [];
  const lo = range?.from ? dayStartOf(range.from) : null;
  const hiRaw = range?.to ? dayStartOf(range.to) : null;
  const hi = hiRaw != null ? hiRaw + 86400 : null;
  const hits: SearchHit[] = [];
  for (const rec of recs) {
    if (lo != null && rec.start < lo) continue;
    if (hi != null && rec.start >= hi) continue;
    (rec.clips ?? []).forEach((clip, clipIndex) => {
      const lyricLines = clip.lyrics ?? [];
      const { hm, date } = clipClock(rec, clip);
      const dateText = date + ' ' + date.slice(5).replace('-', '/');
      let line: string | null = null;
      let matched = true;
      for (const tok of tokens) {
        if (tok.kind === 'bare') {
          const v = tok.v;
          const inTitle = (clip.title || '').toLowerCase().includes(v);
          const hitLine = lyricLines.find((l) => (l.text || '').toLowerCase().includes(v));
          const inDate = dateText.toLowerCase().includes(v);
          if (!inTitle && !hitLine && !inDate) { matched = false; break; }
          if (hitLine && !inTitle && line == null) line = hitLine.text;
        } else if (tok.field === 'title') {
          if (!(clip.title || '').toLowerCase().includes(tok.v.toLowerCase())) { matched = false; break; }
        } else if (tok.field === 'lyrics') {
          const hit = lyricLines.find((l) => (l.text || '').toLowerCase().includes(tok.v.toLowerCase()));
          if (!hit) { matched = false; break; }
          line = hit.text;
        } else if (tok.field === 'time') {
          if (!matchTime(tok.v, hm)) { matched = false; break; }
        } else if (tok.field === 'date') {
          if (!matchDate(tok.v, date)) { matched = false; break; }
        } else {
          matched = false; // 未知字段视为不匹配，避免静默全匹配
          break;
        }
      }
      if (matched) hits.push({ rec, clipIndex, clip, line });
    });
    if (hits.length >= 100) break;
  }
  return hits.slice(0, 100);
}
