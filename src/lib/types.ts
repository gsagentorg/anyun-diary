export interface Clip {
  file: string;
  opus: string;
  offsetStart: number;
  offsetEnd: number;
  seg: string;
  title: string;
  source: string;
}

export interface Segment {
  start: number;
  end: number;
}

export interface Recording {
  file: string;
  start: number; // epoch s (Asia/Shanghai)
  duration: number | null;
  segments: Segment[];
  clips: Clip[];
}

export interface DiaryData {
  generatedAt: number;
  timezone: string;
  recordings: Recording[];
}

/** 录像内三态分解: 歌 / 手工切片 / zzz */
export interface Block {
  kind: 'song' | 'manual' | 'zzz';
  start: number;
  end: number;
  clip?: Clip;
}

/** 把一段 [lo,hi) 减去 cuts, 返回剩余区间 */
function subtract(lo: number, hi: number, cuts: [number, number][]): [number, number][] {
  const pts: Array<[number, number]> = [[lo, 0], [hi, 0]];
  for (const [a, b] of cuts) {
    pts.push([a, 1], [b, -1]);
  }
  pts.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const out: [number, number][] = [];
  let depth = 0, s = lo;
  for (const [p, d] of pts) {
    if (depth === 0 && p > s) out.push([s, Math.min(p, hi)]);
    depth += d;
    s = p;
  }
  return out.filter(([a, b]) => b - a > 0.05);
}

export function blocksOf(rec: Recording): Block[] {
  const dur = rec.duration ?? 0;
  const segs = rec.segments ?? [];
  const clips = rec.clips ?? [];
  const blocks: Block[] = [];

  // 歌: clip 覆盖区
  for (const c of clips) {
    blocks.push({ kind: 'song', start: c.offsetStart, end: c.offsetEnd, clip: c });
  }
  // 手工切片: llc 段减去歌
  const songCuts = clips.map((c): [number, number] => [c.offsetStart, c.offsetEnd]);
  for (const s of segs) {
    for (const [a, b] of subtract(s.start, s.end, songCuts)) {
      blocks.push({ kind: 'manual', start: a, end: b });
    }
  }
  // zzz: 录像内减去所有 llc 段
  const segCuts = segs.map((s): [number, number] => [s.start, s.end]);
  for (const [a, b] of subtract(0, dur, segCuts)) {
    blocks.push({ kind: 'zzz', start: a, end: b });
  }
  return blocks.sort((x, y) => x.start - y.start);
}

export const fmtOffset = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export const fmtClock = (epoch: number) =>
  new Date(epoch * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });

export const fmtDay = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });

export const fmtDur = (s: number) => {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = s / 60;
  return m < 60 ? `${m.toFixed(1)}min` : `${(m / 60).toFixed(1)}h`;
};

/** 按 title 哈希出稳定 hue */
export function hueOf(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  return h % 360;
}

export const SOURCE_LABEL: Record<string, string> = {
  asr: 'AI识曲(ASR)',
  shazam: 'AI识曲(Shazam)',
  'owner-confirmed': '已确认',
};
