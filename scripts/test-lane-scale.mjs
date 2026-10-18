import { buildLaneScale, grayLStar, lstarToRgb } from '../src/lib/lane-scale.ts';

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

  const exp = [6.17, 24.69, 12.35, 37.04, 160.49, 74.07, 685.2];
  lane1.segs.forEach((s, i) =>
    ck(`case1 seg${i}(${s.kind}) 宽≈${exp[i]}`, close(s.width, exp[i]), `${fmt(s.width)} / 期望 ${exp[i]}`),
  );

  const sum = lane1.segs.reduce((a, s) => a + s.width, 0);
  ck('case1 Σ宽=1000±0.5', close(sum, 1000, 0.5), fmt(sum));
  ck('case1 xs≈2.4691', close(lane1.xs, 1000 / 405, 1e-3), fmt(lane1.xs, 5));

  const blanks = lane1.segs.filter((s) => s.kind === 'blank');
  blanks.forEach((b, i) => ck(`case1 blank${i} c≈4`, close(b.c, 4, 0.01), fmt(b.c, 4)));
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
  const expS = [6.8027, 27.2109, 965.9864];
  laneS.segs.forEach((s, i) =>
    ck(`case4 seg${i}(${s.kind})≈${expS[i]}`, close(s.width, expS[i]), `${fmt(s.width, 4)} / 期望 ${expS[i]}`),
  );
  const sumS = laneS.segs.reduce((a, s) => a + s.width, 0);
  ck('case4 Σ宽=1000±0.5', close(sumS, 1000, 0.5), fmt(sumS, 4));
  const blankTotal = laneS.segs.filter((s) => s.kind === 'blank').reduce((a, s) => a + s.width, 0);
  const songW = laneS.segs.find((s) => s.kind === 'song').width;
  ck('case4 比例正确（song:blank = 10:357.5）', close(songW / blankTotal, 10 / 357.5, 1e-3), fmt(songW / blankTotal, 5));
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

log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
