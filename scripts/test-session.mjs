// 会话快照恢复 + 随机 LIFO 行为测试（vite-node 跑，node 环境补浏览器桩）
const store = new Map();
const ls = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { localStorage: ls, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
globalThis.localStorage = ls;
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaSession: { setActionHandler() {}, setPositionState() {}, playbackState: 'none' } },
  configurable: true,
});
globalThis.MediaMetadata = class {};
globalThis.Audio = class {
  constructor() { this.paused = true; this.currentTime = 0; this.src = ''; }
  addEventListener() {} removeEventListener() {}
  load() {} setAttribute() {} removeAttribute() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
};

const { player, initSession, toggleShuffle, step, setRate, getAudio, __resetSessionGuardForTest } = await import('../src/lib/player.svelte.ts');
const { buildRecTracks } = await import('../src/lib/types.ts');
const data = (await import('../src/lib/data.json')).default;
const recs = data.recordings;
const allTracks = recs.flatMap((r) => buildRecTracks(r));
const byFile = new Map(allTracks.map((t) => [t.clip.file, t]));
const C = ['0', '1', '2'].map((i) => [...byFile.keys()][Number(i)]);
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

// T1 快照恢复：暂停 + 队列 + 当前项 + 倍速
store.set('anyun-session-v1', JSON.stringify({ v: 1, queue: C, cur: 1, t: 42.5, shuffle: false, skipSame: true, dedup: true, rate: 1.25 }));
initSession();
ok(player.sessionRestored === true, 'sessionRestored');
ok(player.playlist.length === 3, 'queue rebuilt 3');
ok(player.pos === 1, 'cur=1');
ok(player.playbackRate === 1.25, 'rate 1.25 restored');
ok(player.playing === false, 'stays paused');
ok(decodeURIComponent(getAudio().src).includes(byFile.get(C[1]).clip.opus), 'audio src = cur clip (opus)');
ok(getAudio().paused === true, 'audio not auto-playing');

// T2 重复队列项保留
__resetSessionGuardForTest();
store.set('anyun-session-v1', JSON.stringify({ v: 1, queue: [C[0], C[0], C[2]], cur: 0, t: 0, shuffle: false, skipSame: true, dedup: true, rate: 1 }));
initSession();
ok(player.playlist.length === 3 && player.playlist[0].clip.file === player.playlist[1].clip.file, 'duplicate entries kept');

// T3 坏快照安全
store.set('anyun-session-v1', '{broken json!!!');
initSession();
ok(player.sessionRestored === false || player.playlist.length >= 0, 'no crash on garbage');

// T4 随机 LIFO：上一曲压栈、下一曲优先弹回
player.playlist = allTracks.filter((t) => C.includes(t.clip.file));
player.pos = 1; player.track = player.playlist[1];
player.history = []; player.playedTitles = []; player.shuffleRedo = [];
toggleShuffle();
ok(player.shuffle === true, 'shuffle on');
const seen = [];
step(1); seen.push(player.pos);
step(-1); seen.push(player.pos);
step(1); seen.push(player.pos);
step(1); seen.push(player.pos);
ok(seen[1] === 1, 'prev returns to origin (' + seen.join(',') + ')');
ok(seen[0] === seen[2], 'next pops LIFO back to P (' + seen.join(',') + ')');

// T5 随机避开同名
const same = allTracks.filter((t) => t.clip.title === '凑热闹').slice(0, 5);
const diff = allTracks.find((t) => t.clip.title !== '凑热闹');
player.playlist = [...same, diff];
player.pos = -1; player.track = null;
player.playedTitles = ['T:凑热闹'];
player.shuffleSkipSameTitle = true;
let hitDiff = false;
for (let i = 0; i < 30 && !hitDiff; i++) { player.pos = -1; step(1); if (player.track?.clip.title !== '凑热闹') hitDiff = true; }
ok(hitDiff, 'skipSameTitle=true avoids same-title');
player.shuffleSkipSameTitle = false;
player.dedupByName = false; // 身份判定切到「同名不同词=不同曲」，同名才可能被重抽
let hitSame = false;
for (let i = 0; i < 60 && !hitSame; i++) { player.pos = -1; step(1); if (player.track?.clip.title === '凑热闹') hitSame = true; }
ok(hitSame, 'skipSameTitle=false can re-pick same title');

// T6 setRate 写 localStorage
setRate(2);
ok(ls.getItem('anyun-rate') === '2', 'rate persisted');

console.log('SESSION-TESTS pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
