import assert from 'node:assert/strict';
import { pickShuffleIndex, trackKeyOf } from '../src/lib/playlist-core.ts';

// 播放列表：A x2（同名不同场次）、B x2、C、D；开局已播 A（下标0）
const clips = ['A', 'A', 'B', 'B', 'C', 'D'].map((t, i) => ({ title: t, file: 'f' + i }));
const keys = clips.map(trackKeyOf);

// Fixed seed makes failures reproducible; each suite runs in its own process.
let seed = 12345;
Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
const played = [keys[0]];
let cur = 0;
const segments = [[]]; // 每次池重置开新段
for (let k = 0; k < 40; k++) {
  const pick = pickShuffleIndex(keys, played, cur);
  assert.ok(pick, 'shuffle draw ' + k + ' must produce a candidate');
  assert.ok(Number.isInteger(pick.index) && pick.index >= 0 && pick.index < keys.length, 'valid candidate index');
  if (pick.reset) segments.push([]);
  cur = pick.index;
  played.push(keys[cur]);
  segments[segments.length - 1].push(clips[cur].title + '#' + cur);
}

console.log('segments =', JSON.stringify(segments));

// 1) 每段内：标题不得重复（同名歌曲按标题去重的核心验证）
for (const [si, seg] of segments.entries()) {
  const titles = seg.map((d) => d.split('#')[0]);
  const uniq = new Set(titles);
  assert.equal(uniq.size, titles.length, 'segment ' + si + ': unique titles');
}
// 2) 第 0 段不得包含开局已播的 A
assert.ok(!segments[0].some((d) => d.startsWith('A#')), 'first segment excludes already played A');
// 3) 全程无连续同一下标
const all = segments.flat();
assert.equal(all.length, 40, 'all 40 draws completed');
assert.ok(segments.length > 1, 'pool reset was exercised');
for (let k = 1; k < all.length; k++) {
  assert.notEqual(all[k], all[k - 1], 'draw ' + k + ': no consecutive same index');
}

console.log('shuffle: 40 deterministic draws passed');
