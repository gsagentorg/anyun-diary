export type Interval = { start: number; end: number };

export type SegKind = 'song' | 'micro' | 'blank';

export type Seg = {
  kind: SegKind;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
  minutes: number;
  width: number;
  c: number | null;
};

export type LaneScale = {
  segs: Seg[];
  xs: number;
  xAt(t: number): number;
  tAt(x: number): number;
};

export type LaneScaleParams = {
  M: number;
  sigma: number;
  rho: number;
  minGapPx: number;
};

const DEFAULT_PARAMS: LaneScaleParams = { M: 600, sigma: 1, rho: 0.25, minGapPx: 6 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 把一天的音频时间线压缩成三段式泳道坐标：
 * song（原速） / micro（簇内小间隙，按 sigma 压缩） / blank（大段空白，按 rho 压缩）。
 * 全部用分钟做中间计算，避免秒级大数浮点误差。
 */
export function buildLaneScale(
  songs: Interval[],
  widthPx: number,
  dayStart: number,
  dayEnd: number,
  p: Partial<LaneScaleParams> = {},
): LaneScale | null {
  if (!songs || songs.length === 0) return null;
  if (!(widthPx > 0) || !(dayEnd > dayStart)) return null;
  const P: LaneScaleParams = { ...DEFAULT_PARAMS, ...p };

  const list = songs
    .map((s) => ({ start: Math.max(s.start, dayStart), end: Math.min(s.end, dayEnd) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (list.length === 0) return null;

  type Raw = { kind: SegKind; t0: number; t1: number };
  const raws: Raw[] = [];
  let cursor = dayStart;
  let i = 0;
  while (i < list.length) {
    if (list[i].start > cursor) raws.push({ kind: 'blank', t0: cursor, t1: list[i].start });
    raws.push({ kind: 'song', t0: list[i].start, t1: list[i].end });
    let j = i + 1;
    while (j < list.length && list[j].start - list[j - 1].end < P.M) {
      const g0 = list[j - 1].end;
      const g1 = list[j].start;
      if (g1 > g0) raws.push({ kind: 'micro', t0: g0, t1: g1 });
      raws.push({ kind: 'song', t0: list[j].start, t1: list[j].end });
      j++;
    }
    cursor = list[j - 1].end;
    i = j;
  }
  if (dayEnd > cursor) raws.push({ kind: 'blank', t0: cursor, t1: dayEnd });

  const mins = (a: number, b: number) => (b - a) / 60;
  let T_song = 0;
  let T_micro = 0;
  let T_blank = 0;
  for (const r of raws) {
    const m = mins(r.t0, r.t1);
    if (r.kind === 'song') T_song += m;
    else if (r.kind === 'micro') T_micro += m;
    else T_blank += m;
  }
  const denom = T_song + P.sigma * T_micro + P.rho * T_blank;
  if (!(denom > 0)) return null;
  const xs = widthPx / denom;

  const segs: Seg[] = raws.map((r) => {
    const m = mins(r.t0, r.t1);
    const w = r.kind === 'song' ? m * xs : r.kind === 'micro' ? m * P.sigma * xs : m * P.rho * xs;
    return { kind: r.kind, t0: r.t0, t1: r.t1, x0: 0, x1: 0, minutes: m, width: w, c: null };
  });

  const blanks = segs.filter((s) => s.kind === 'blank');
  const EPS = 1e-9;
  const floored = new Set<Seg>();
  let deficit = 0;
  for (const b of blanks) {
    if (b.width < P.minGapPx) {
      deficit += P.minGapPx - b.width;
      b.width = P.minGapPx;
      floored.add(b);
    }
  }
  if (deficit > 0) {
    const others = blanks.filter((b) => !floored.has(b));
    const sum = others.reduce((a, b) => a + b.width, 0);
    if (others.length > 0 && sum > EPS) {
      for (const b of others) b.width -= deficit * (b.width / sum);
    } else {
      let widest = blanks[0];
      for (const b of blanks) if (b.width > widest.width) widest = b;
      widest.width = Math.max(EPS, widest.width - deficit);
    }
  }
  for (const s of segs) if (!(s.width > 0)) s.width = EPS;

  const totalW = segs.reduce((a, s) => a + s.width, 0);
  if (Math.abs(totalW - widthPx) > 1e-6 && blanks.length > 0) {
    let widest = blanks[0];
    for (const b of blanks) if (b.width > widest.width) widest = b;
    widest.width = Math.max(EPS, widest.width + (widthPx - totalW));
  }

  let x = 0;
  for (const s of segs) {
    s.x0 = x;
    x += s.width;
    s.x1 = x;
    if (s.kind === 'blank') s.c = (s.minutes / s.width) * xs;
  }

  const last = segs[segs.length - 1];
  const xAt = (t: number): number => {
    if (t <= segs[0].t0) return segs[0].x0;
    if (t >= last.t1) return last.x1;
    for (const s of segs) {
      if (t <= s.t1) return s.x0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0);
    }
    return last.x1;
  };
  const tAt = (xp: number): number => {
    if (xp <= segs[0].x0) return segs[0].t0;
    if (xp >= last.x1) return last.t1;
    for (const s of segs) {
      if (xp <= s.x1) return s.t0 + ((xp - s.x0) / (s.x1 - s.x0)) * (s.t1 - s.t0);
    }
    return last.t1;
  };

  return { segs, xs, xAt, tAt };
}

/** 压缩倍数 c → 灰度 L*（light 越亮、dark 越暗），clamp 到可读区间 */
export function grayLStar(c: number, dark = false): number {
  const k = Math.log2(Math.max(c, 1));
  return dark ? clamp(25 + 14 * k, 25, 72) : clamp(88 - 14 * k, 40, 88);
}

/** 标准 L*a*b*（a=b=0）→ XYZ(D65) → sRGB，gamma 传递函数，round 0-255 */
export function lstarToRgb(L: number): [number, number, number] {
  const finv = (t: number) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const f = finv((L + 16) / 116);
  const X = 95.047 * f;
  const Y = 100 * f;
  const Z = 108.883 * f;
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const to255 = (v: number) => Math.round(clamp(enc(v), 0, 1) * 255);
  return [
    to255((3.2406 * X - 1.5372 * Y - 0.4986 * Z) / 100),
    to255((-0.9689 * X + 1.8758 * Y + 0.0415 * Z) / 100),
    to255((0.0557 * X - 0.204 * Y + 1.057 * Z) / 100),
  ];
}
