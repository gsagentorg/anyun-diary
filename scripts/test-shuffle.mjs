import { pickShuffleIndex, trackKeyOf } from '../src/lib/playlist-core.ts';

// 播放列表：A x2（同名不同场次）、B x2、C、D；开局已播 A（下标0）
const clips = ['A', 'A', 'B', 'B', 'C', 'D'].map((t, i) => ({ title: t, file: 'f' + i }));
const keys = clips.map(trackKeyOf);

const played = [keys[0]];
let cur = 0;
const segments = [[]]; // 每次池重置开新段
for (let k = 0; k < 40; k++) {
  const pick = pickShuffleIndex(keys, played, cur);
  if (!pick) break;
  if (pick.reset) segments.push([]);
  cur = pick.index;
  played.push(keys[cur]);
  segments[segments.length - 1].push(clips[cur].title + '#' + cur);
}

console.log('segments =', JSON.stringify(segments));

let fails = 0;
// 1) 每段内：标题不得重复（同名歌曲按标题去重的核心验证）
for (const [si, seg] of segments.entries()) {
  const titles = seg.map((d) => d.split('#')[0]);
  const uniq = new Set(titles);
  if (uniq.size !== titles.length) { console.log('FAIL 段', si, '内标题重复:', seg.join(' ')); fails++; }
}
// 2) 第 0 段不得包含开局已播的 A
if (segments[0].some((d) => d.startsWith('A#'))) { console.log('FAIL 第0段抽到已播的 A'); fails++; }
// 3) 全程无连续同一下标
const all = segments.flat();
for (let k = 1; k < all.length; k++) {
  if (all[k] === all[k - 1]) { console.log('FAIL 连续同曲:', all[k - 1], all[k]); fails++; }
}

console.log(fails === 0 ? 'PASS（40 次随机：段内标题唯一、已播的 A 段0不抽、无连续同曲）' : 'FAIL x' + fails);
process.exit(fails === 0 ? 0 : 1);
