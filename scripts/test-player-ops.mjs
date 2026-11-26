// 播放器操作测试：清空播放列表（含停止/复位）与三态播放模式循环。
// 独立进程 + 浏览器桩，复用合成夹具，不依赖仓库内 data.json / 真实音频。
import assert from 'node:assert/strict';

const store = new Map();
const ls = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { localStorage: ls, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = ls;
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

const media = {
  metadata: undefined,
  playbackState: 'none',
  setActionHandler() {},
  setPositionState() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: media }, configurable: true });
globalThis.MediaMetadata = class {};

const audios = [];
class AudioStub {
  constructor() {
    this.paused = true;
    this.currentTime = 0;
    this.src = '';
    this.duration = 120;
    this.playbackRate = 1;
    this.plays = 0;
    this.pauses = 0;
    this.listeners = new Map();
    audios.push(this);
  }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  removeEventListener() {}
  load() {}
  setAttribute() {}
  getAttribute() {
    return this.src;
  }
  removeAttribute() {
    this.src = '';
    this.currentTime = 0;
  }
  play() {
    this.plays++;
    this.paused = false;
    for (const fn of this.listeners.get('play') ?? []) fn();
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
    this.paused = true;
    for (const fn of this.listeners.get('pause') ?? []) fn();
  }
}
globalThis.Audio = AudioStub;

const { player, clearQueue, setPlayMode, cyclePlayMode, onTrackEnded, getAudio, step, hasNextTrack, initSession, scheduleSessionSave, __resetSessionGuardForTest } = await import(
  '../src/lib/player.svelte.ts'
);

const audio = (i) => ({
  id: 'ops-audio-' + i,
  file: 'ops-' + i + '.opus',
  opus: 'audio/ops-' + i + '.opus',
  title: 'Ops fixture ' + i,
  startAt: 1794000000 + i * 60,
  duration: 120,
  lyrics: [],
  monthId: '2026-11',
});
const tracks = [0, 1, 2, 3].map((i) => ({ queueEntryId: 'ops-entry-' + i, audio: audio(i) }));

let pass = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    console.log('FAIL:', name);
    process.exitCode = 1;
  }
};
const reset = () => {
  player.playlist = tracks.slice();
  player.pos = 1;
  player.track = player.playlist[1];
  player.playing = true;
  player.loading = true;
  player.history = [0];
  player.playedTitles = ['T:Ops fixture 0'];
  player.shuffleRedo = [2];
};
const forceMode = (m) => {
  if (player.mode !== m) setPlayMode(m);
};

// T1 清空：队列/当前曲/进度/播放态/媒体会话/快照全部复位
reset();
store.set(
  'anyun-session-v2',
  JSON.stringify({ v: 2, queue: tracks, cur: 1, t: 30, shuffle: false, skipSame: true, dedup: true, rate: 1 }),
);
const a = getAudio();
a.src = 'https://example.invalid/audio/x.opus';
a.currentTime = 42;
a.paused = false;
media.playbackState = 'playing';
media.metadata = { title: 'x' };
clearQueue();
ok(player.playlist.length === 0, 'queue cleared');
ok(player.pos === -1, 'position reset');
ok(player.track === null, 'current track cleared');
ok(player.playing === false, 'playing state cleared');
ok(player.loading === false, 'loading state cleared');
ok(player.history.length === 0 && player.playedTitles.length === 0 && player.shuffleRedo.length === 0, 'random state cleared');
ok(a.paused === true, 'audio paused');
ok(a.src === '' && a.currentTime === 0, 'audio source and progress reset');
ok(media.playbackState === 'none', 'media session playbackState none');
ok(media.metadata === null, 'media session metadata cleared');
ok(!store.has('anyun-session-v2'), 'session snapshot removed');
ok(player.sessionRestored === false, 'restored flag reset');

// T1b 清空后的迟到期保存与重载都不能复活队列/当前曲
reset();
store.set(
  'anyun-session-v2',
  JSON.stringify({ v: 2, queue: tracks, cur: 1, t: 30, shuffle: false, skipSame: true, dedup: true, rate: 1 }),
);
scheduleSessionSave(); // 清空前已排队的去抖保存
clearQueue();
await new Promise((resolve) => setTimeout(resolve, 400));
ok(!store.has('anyun-session-v2'), 'late debounced save cannot resurrect snapshot');
__resetSessionGuardForTest();
initSession();
ok(
  player.playlist.length === 0 && player.track === null && player.pos === -1,
  'reload cannot restore cleared queue or current track',
);

// T2 三态循环：随机 → 单曲循环 → 顺序 → 随机
setPlayMode('random');
ok(player.shuffle === true, 'shuffle mirror follows the mode');
ok(cyclePlayMode() === 'repeat-one' && player.mode === 'repeat-one', 'random → repeat-one');
ok(cyclePlayMode() === 'sequential' && player.mode === 'sequential', 'repeat-one → sequential');
ok(player.shuffle === false, 'sequential clears the shuffle mirror');
ok(cyclePlayMode() === 'random' && player.mode === 'random', 'sequential → random');
ok(ls.getItem('anyun-play-mode') === 'random', 'mode persisted');
const beforeInvalid = player.mode;
setPlayMode('bogus');
ok(player.mode === beforeInvalid, 'invalid mode ignored');

// T3 单曲循环：自然结束从头重播，位置不变
reset();
setPlayMode('repeat-one');
const cur = player.track;
const playBefore = getAudio().plays;
getAudio().currentTime = 118;
onTrackEnded();
ok(player.track === cur && player.pos === 1, 'repeat-one keeps current track');
ok(getAudio().currentTime === 0, 'repeat-one rewinds to start');
ok(getAudio().plays === playBefore + 1, 'repeat-one calls play again');

// T4 顺序播放：列表末尾自然结束不再前进
reset();
setPlayMode('sequential');
player.pos = player.playlist.length - 1;
player.track = player.playlist[player.pos];
const endPos = player.pos;
const playsAtEnd = getAudio().plays;
onTrackEnded();
ok(player.pos === endPos, 'sequential stops at end');
ok(getAudio().plays === playsAtEnd, 'sequential end does not replay');

// T5 随机模式仍可用（下一首会换到别的曲目）
reset();
player.pos = 0;
player.track = player.playlist[0];
player.playedTitles = [];
player.history = [];
player.shuffleRedo = [];
setPlayMode('random');
step(1);
ok(player.pos !== 0 && player.playlist[player.pos] != null, 'random next moves to another track');

// T6 单曲循环下「手动下一首」仍按队列走（循环只作用于自然播完）
reset();
setPlayMode('repeat-one');
player.pos = 0;
player.track = player.playlist[0];
step(1);
ok(player.pos === 1, 'repeat-one manual next follows the queue');

// T7 随机模式队尾（issue #4 复现路径）：顺序走到队尾后切随机，「下一首」可用且真的换曲
reset();
forceMode('sequential');
player.pos = player.playlist.length - 1;
player.track = player.playlist[player.pos];
forceMode('random'); // 切随机：已播池只剩当前曲
ok(hasNextTrack() === true, 'shuffle at tail: next is available');
const shuffleTail = player.pos;
step(1);
ok(player.pos !== shuffleTail && player.playlist[player.pos] != null, 'shuffle at tail: manual next moves to another track');

// T8 随机模式队尾自然播完：同样要换到另一首合格曲目
reset();
forceMode('sequential');
player.pos = player.playlist.length - 1;
player.track = player.playlist[player.pos];
player.playing = true;
forceMode('random');
const naturalTail = player.pos;
const playsBeforeNatural = getAudio().plays;
onTrackEnded();
ok(player.pos !== naturalTail, 'shuffle at tail: natural completion picks another track');
ok(player.track === player.playlist[player.pos], 'shuffle at tail: natural completion keeps track<->pos in sync');
ok(getAudio().plays === playsBeforeNatural + 1, 'shuffle at tail: natural completion starts playback');

// T9 顺序模式队尾：保持原行为（下一首禁用、自然结束不前进）
reset();
forceMode('sequential');
player.pos = player.playlist.length - 1;
player.track = player.playlist[player.pos];
ok(hasNextTrack() === false, 'sequential tail: next disabled');
const seqTail = player.pos;
onTrackEnded();
step(1);
ok(player.pos === seqTail, 'sequential tail: neither natural end nor manual next advances');

// T10 单曲队列：随机/顺序下「下一首」都保持禁用，step 不动
reset();
player.playlist = [tracks[0]];
player.pos = 0;
player.track = player.playlist[0];
forceMode('random');
ok(hasNextTrack() === false, 'one-track queue: shuffle next disabled');
step(1);
ok(player.pos === 0, 'one-track queue: shuffle step does not move');
forceMode('sequential');
ok(hasNextTrack() === false, 'one-track queue: sequential next disabled');

// T11 随机模式回退栈：栈顶有可回跳项时「下一首」可用，且 step 走栈（与按钮态一致）
reset();
forceMode('random');
player.pos = player.playlist.length - 1;
player.track = player.playlist[player.pos];
player.playedTitles = tracks.map((_, i) => 'T:Ops fixture ' + i);
player.shuffleRedo = [0];
ok(hasNextTrack() === true, 'shuffle redo top: next available');
step(1);
ok(player.pos === 0, 'shuffle redo top: next pops the redo stack');

// T12 全同名队列（避开同名 + 已播池抽干）：按钮态跟随「池重置」回退，而不是判成没有下一首
reset();
const twins = [0, 1].map((i) => ({ queueEntryId: 'ops-twin-' + i, audio: { ...audio(i), title: 'Same title' } }));
player.playlist = twins;
player.pos = 1;
player.track = player.playlist[1];
player.shuffleSkipSameTitle = true;
player.playedTitles = ['T:Same title'];
forceMode('random');
ok(hasNextTrack() === true, 'shuffle all-same-title pool reset: next available');
step(1);
ok(player.pos === 0, 'shuffle all-same-title pool reset: next advances via reset fallback');

console.log(`player-ops: ${pass} checks passed`);
process.exit(process.exitCode ?? 0);