import { buildLaneScale, lstarForRange, grayLStar, lstarToRgb, layoutSongs } from '../src/lib/lane-scale.ts';

let pass = 0;
let total = 0;
const log = console.log;

function ck(name, cond, actual) {
  total++;
  if (cond) {
    pass++;
    log(`PASS ${name}${actual === undefined ? '' : ` — 实际: ${actual}`}`);
  } else {
    log(`FAIL ${name} — 实际: ${actual}`);
  }
}

const close = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const fmt = (n, d = 3) => Number(n).toFixed(d);

// ---------- 用例 1：三级压缩基准 ----------
const songs1 = [
  { start: 10 * 60, end: 20 * 60 },
  { start: 25 * 60, end: 40 * 60 },
  { start: 300 * 60, end: 330 * 60 },
];
const lane1 = buildLaneScale(songs1, 1000, 0, 86400);

ck('case1 非空返回', lane1 != null, lane1 == null ? 'null' : 'ok');
if (lane1) {
  const kinds = lane1.segs.map((s) => s.kind).join(',');
  ck('case1 段序列 blank,song,micro,song,blank,song,blank', kinds === 'blank,song,micro,song,blank,song,blank', kinds);
  ck('case1 段数=7', lane1.segs.length === 7, lane1.segs.length);

  const exp = [6, 133.333, 66.667, 200, 36.818, 400, 157.182];
  lane1.segs.forEach((s, i) =>
    ck(`case1 seg${i}(${s.kind}) 宽≈${exp[i]}`, close(s.width, exp[i]), `${fmt(s.width)} / 期望 ${exp[i]}`),
  );

  const sum = lane1.segs.reduce((a, s) => a + s.width, 0);
  ck('case1 Σ宽=1000±0.5', close(sum, 1000, 0.5), fmt(sum));
  ck('case1 xs≈13.3333', close(lane1.xs, 80 / 6, 1e-3), fmt(lane1.xs, 5));

  const CEXP = [22.222, 94.158, 94.158];
  const blanks = lane1.segs.filter((s) => s.kind === 'blank');
  blanks.forEach((b, i) => ck(`case1 blank${i} c≈CEXP`, close(b.c, CEXP[i], 0.1), fmt(b.c, 4)));
  ck('case1 grayLStar(4)=60', grayLStar(4) === 60, grayLStar(4));
}

// ---------- 用例 2：minGapPx 保底 ----------
const lane2 = buildLaneScale(songs1, 1000, 9 * 60, 86400);
ck('case2 非空返回', lane2 != null, lane2 == null ? 'null' : 'ok');
if (lane2) {
  const b0 = lane2.segs[0];
  ck('case2 首段为 blank', b0.kind === 'blank', b0.kind);
  ck('case2 首 blank 由 0.62 抬到 6', close(b0.width, 6, 0.01), fmt(b0.width));
  const sum2 = lane2.segs.reduce((a, s) => a + s.width, 0);
  ck('case2 保底后 Σ宽=1000±0.5', close(sum2, 1000, 0.5), fmt(sum2));
  ck('case2 全部段宽>0', lane2.segs.every((s) => s.width > 0), lane2.segs.map((s) => fmt(s.width)).join(','));
  ck(
    'case2 其余 blank 已扣回（blank2+blank3 < 单独计算值）',
    lane2.segs.filter((s) => s.kind === 'blank').slice(1).reduce((a, s) => a + s.width, 0) < 160.49 + 685.2,
    fmt(lane2.segs.filter((s) => s.kind === 'blank').slice(1).reduce((a, s) => a + s.width, 0)),
  );
}

// ---------- 用例 3：严格单调 + 往返 ----------
if (lane1) {
  let mono = true;
  let cont = true;
  for (let i = 0; i < lane1.segs.length; i++) {
    const s = lane1.segs[i];
    if (!(s.x1 > s.x0) || !(s.width > 0)) mono = false;
    if (i > 0 && Math.abs(lane1.segs[i - 1].x1 - s.x0) > 1e-6) cont = false;
  }
  ck('case3 各段 x 严格递增且宽>0', mono, mono ? 'ok' : 'broken');
  ck('case3 段首尾相接', cont, cont ? 'ok' : 'gap');

  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let rt = true;
  let maxErr = 0;
  for (let n = 0; n < 20; n++) {
    const t = rnd() * 86400;
    const back = lane1.tAt(lane1.xAt(t));
    const e = Math.abs(back - t);
    if (e > maxErr) maxErr = e;
    if (e > 0.6) rt = false;
  }
  ck('case3 往返 tAt(xAt(t))=t（±0.01 分钟）', rt, `maxErr=${fmt(maxErr, 4)}s`);
}

// ---------- 用例 4：空输入 / 单歌全天 ----------
const empty = buildLaneScale([], 1000, 0, 86400);
ck('case4 空输入⇒null', empty === null, empty === null ? 'null' : 'not null');

const laneS = buildLaneScale([{ start: 600, end: 1200 }], 1000, 0, 86400);
ck('case4 单歌非空', laneS != null, laneS == null ? 'null' : 'ok');
if (laneS) {
  ck('case4 单歌段数=3', laneS.segs.length === 3, laneS.segs.length);
  const ks = laneS.segs.map((s) => s.kind).join(',');
  ck('case4 单歌序列 blank,song,blank', ks === 'blank,song,blank', ks);
  const expS = [6, 800, 194.0];
  laneS.segs.forEach((s, i) =>
    ck(`case4 seg${i}(${s.kind})≈${expS[i]}`, close(s.width, expS[i]), `${fmt(s.width, 4)} / 期望 ${expS[i]}`),
  );
  const sumS = laneS.segs.reduce((a, s) => a + s.width, 0);
  ck('case4 Σ宽=1000±0.5', close(sumS, 1000, 0.5), fmt(sumS, 4));
  const blankTotal = laneS.segs.filter((s) => s.kind === 'blank').reduce((a, s) => a + s.width, 0);
  const songW = laneS.segs.find((s) => s.kind === 'song').width;
ck('case4 歌区占比≈0.8', close(laneS.segs.reduce((a2, s2) => a2 + (s2.kind === 'song' ? s2.width : 0), 0) / 1000, 0.8, 0.01), 'ok');
}

// ---------- 用例 5：灰度映射 ----------
ck('grayLStar c=1⇒88', grayLStar(1) === 88, grayLStar(1));
ck('grayLStar c=2⇒74', grayLStar(2) === 74, grayLStar(2));
ck('grayLStar c=8⇒46', grayLStar(8) === 46, grayLStar(8));
ck('grayLStar c=100⇒40（封顶）', grayLStar(100) === 40, grayLStar(100));

const near = lstarToRgb(88);
const deep = lstarToRgb(40);
ck(
  'lstarToRgb(88) 近白（三通道≥200 且差≤3）',
  near.every((v) => v >= 200 && v <= 255) && Math.max(...near) - Math.min(...near) <= 3,
  near.join(','),
);
ck(
  'lstarToRgb(40) 深灰且三通道差≤3',
  deep.every((v) => v < 160) && Math.max(...deep) - Math.min(...deep) <= 3,
  deep.join(','),
);

// ---------- 用例 6：layoutSongs 无重叠自适应布局 ----------
const orderedNoOverlap = (rects, gap = 1) => {
  let ok = true;
  for (let i = 0; i < rects.length; i++) {
    if (!(rects[i].width >= 1)) ok = false;
    if (i > 0) {
      if (rects[i].left < rects[i - 1].left) ok = false; // 顺序不乱
      if (rects[i - 1].left + rects[i - 1].width + gap > rects[i].left) ok = false; // 含 gap 不重叠
    }
  }
  return ok;
};

// 6a 密集链：10 块各 2px、x0 间隔 5px（块间净间隔 3px）
const dense = Array.from({ length: 10 }, (_, i) => ({ x0: i * 5, x1: i * 5 + 2 }));
const rDense = layoutSongs(dense, 12, 1);
ck('case6a 密集链长度=10', rDense.length === 10, rDense.length);
ck('case6a 密集链无重叠且每块≥1px', orderedNoOverlap(rDense), JSON.stringify(rDense));
ck(
  'case6a 密集链尽量 minW（内部块宽=4 受可用约束）',
  rDense.slice(0, 9).every((r) => close(r.width, 4, 1e-9)),
  rDense.map((r) => fmt(r.width)).join(','),
);
ck('case6a 密集链首块 left=0', close(rDense[0].left, 0, 1e-9), rDense[0].left);

// 6b 宽松：全部 ≥minW 且 left==x0
const loose = [{ x0: 0, x1: 10 }, { x0: 100, x1: 110 }, { x0: 200, x1: 220 }];
const rLoose = layoutSongs(loose, 12, 1);
ck('case6b 宽松长度=3', rLoose.length === 3, rLoose.length);
ck('case6b 宽松全部 ≥minW', rLoose.every((r) => r.width >= 12), rLoose.map((r) => fmt(r.width)).join(','));
ck(
  'case6b 宽松 left==x0',
  rLoose.every((r, i) => close(r.left, loose[i].x0, 1e-9)),
  rLoose.map((r) => fmt(r.left)).join(','),
);
ck('case6b 宽松无重叠', orderedNoOverlap(rLoose), JSON.stringify(rLoose));

// 6c 相邻零间隔
const adjacent = [{ x0: 0, x1: 10 }, { x0: 10, x1: 20 }];
const rAdj = layoutSongs(adjacent, 12, 1);
ck('case6c 零间隔无重叠', orderedNoOverlap(rAdj), JSON.stringify(rAdj));
ck('case6c 零间隔每块 ≥1px', rAdj.every((r) => r.width >= 1), rAdj.map((r) => fmt(r.width)).join(','));

// 6d 单块
const rSingle = layoutSongs([{ x0: 0, x1: 10 }], 12, 1);
ck('case6d 单块 left=x0 且宽=max(minW,x1-x0)=12', rSingle.length === 1 && close(rSingle[0].left, 0, 1e-9) && close(rSingle[0].width, 12, 1e-9), JSON.stringify(rSingle));

// 6e 空数组
const rEmpty = layoutSongs([], 12, 1);
ck('case6e 空数组⇒[]', Array.isArray(rEmpty) && rEmpty.length === 0, JSON.stringify(rEmpty));

// 6f 窄容器整体压缩后仍无重叠
const cramped = Array.from({ length: 8 }, (_, i) => ({ x0: i * 8, x1: i * 8 + 30 }));
const rCramped = layoutSongs(cramped, 12, 1);
ck('case6f 窄容器长度=8', rCramped.length === 8, rCramped.length);
ck('case6f 窄容器无重叠且每块≥1px', orderedNoOverlap(rCramped), JSON.stringify(rCramped));
ck(
  'case6f 窄容器两两 left+width+gap ≤ next.left',
  rCramped.every((r, i) => i === 0 || rCramped[i - 1].left + rCramped[i - 1].width + 1 <= r.left),
  JSON.stringify(rCramped),
);

ck('lstarForRange cMin→88', lstarForRange(2, 2, 8) === 88, lstarForRange(2, 2, 8));
ck('lstarForRange cMax→45', lstarForRange(8, 2, 8) === 45, lstarForRange(8, 2, 8));
ck('lstarForRange 中点≈66.5', close(lstarForRange(4, 2, 8), 66.5, 0.1), lstarForRange(4, 2, 8));
ck('lstarForRange 退化区间取中点', close(lstarForRange(4, 4, 4), 66.5, 0.1), lstarForRange(4, 4, 4));
ck('lstarForRange c≤1→88', lstarForRange(1, 2, 8) === 88, lstarForRange(1, 2, 8));

log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
