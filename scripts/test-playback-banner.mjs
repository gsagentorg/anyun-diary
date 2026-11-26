// issue #6：过期错误横幅 + 事件驱动恢复的行为测试。
// 两段：
//  A. 纯状态机（src/lib/playback-banner.ts）：迟到失败、显式暂停、健康播放、现行失败。
//  B. 真实 player.svelte.ts 接线（原生壳分支，桩掉 NativeAudio 桥）：
//     横幅状态与播放意图独立断言；回前台/重连快照经 applyNativeState 和解。
// 运行：npm run test:playback-banner（vite-node）
import assert from 'node:assert/strict';

/* ---------------- A. 纯状态机 ---------------- */
const B = await import('../src/lib/playback-banner.ts');
let checks = 0;
const step = (cond, msg) => { assert.ok(cond, msg); checks++; };
const { beginTrack, failPlayback, fromNative, noteHealthy, noteNotice, notePause, notePlay, NO_BANNER } = B;

const empty = beginTrack('entry-a');
step(empty.identity === 'entry-a' && empty.message === '' && empty.paused === false && empty.failure === false, 'beginTrack starts clean');

const failed = failPlayback(empty, 'entry-a', '加载失败');
step(failed.message === '加载失败' && failed.failure === true, 'current-track failure becomes the banner');
step(failPlayback(failed, 'entry-b', '旧曲失败').message === '加载失败', 'late failure from a superseded track is dropped');
step(failPlayback(failed, '', '无身份').message === '加载失败', 'failure without an identity is dropped');
step(failed.message === '加载失败' && empty.message === '', 'transitions never mutate prior state');

// 显式暂停：作废已显示的失败，且暂停期间的后台重试失败不复活横幅
const paused = notePause(failed, 'entry-a');
step(paused.message === '' && paused.paused === true && paused.failure === false, 'explicit pause clears the superseded failure');
step(failPlayback(paused, 'entry-a', '重试失败').message === '', 'retry failure while explicitly paused stays hidden');
step(fromNative(paused, 'entry-a', { playing: false, error: '重新联网后旧失败' }).message === '', 'foreground/reconnect snapshot cannot resurrect the banner while paused');
step(fromNative(paused, 'entry-a', { playing: false, error: '' }).paused === true, 'paused intent survives a quiet snapshot');

// 用户重新点播放：意图恢复，新的真实失败可以显示
const resumed = notePlay(paused, 'entry-a');
step(resumed.paused === false && resumed.message === '', 'play intent resumes without a banner');
step(failPlayback(resumed, 'entry-a', '音频恢复失败').message === '音频恢复失败', 'a genuine current failure shows after intent resumes');

// 健康播放清掉过期横幅（无论旧的失败是否仍在状态里）
step(noteHealthy(failPlayback(resumed, 'entry-a', '加载失败'), 'entry-a').message === '', 'healthy playback clears a stale failure');
step(noteHealthy(empty, 'entry-b').identity === 'entry-b', 'healthy playback for a new track resets identity');
step(fromNative(failPlayback(resumed, 'entry-a', '加载失败'), 'entry-a', { playing: true, error: '加载失败' }).message === '', 'native playing state clears a stale error mirror');
step(fromNative(failPlayback(resumed, 'entry-a', '加载失败'), 'entry-a', { playing: false, error: '加载失败' }).message === '加载失败', 'native stopped + error is a current failure');
step(fromNative(failPlayback(resumed, 'entry-a', '加载失败'), 'entry-b', { playing: false, error: '' }).identity === 'entry-b', 'native snapshot for a new track supersedes the old banner');

// 非播放类提示：与意图无关，但换曲/健康播放同样会过期
const notice = noteNotice(beginTrack('entry-a'), 'entry-a', '队列超过安全预算');
step(notice.message === '队列超过安全预算' && notice.failure === false, 'queue notice shows without being a playback failure');
step(noteNotice(paused, 'entry-a', '队列超过安全预算').message === '队列超过安全预算', 'notices ignore the paused suppression');
step(noteHealthy(notice, 'entry-a').message === '', 'healthy playback expires a stale notice');
step(noteNotice(noBannerIdentity(), 'entry-a', 'x').paused === false && NO_BANNER.message === '', 'notice for a new identity drops the old paused intent');
function noBannerIdentity() { return NO_BANNER; }

/* ---------------- B. 真实 player.svelte.ts 接线（原生分支） ---------------- */
const store = new Map();
const ls = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = { localStorage: ls, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = ls;
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: { setActionHandler() {}, setPositionState() {} } }, configurable: true });
globalThis.MediaMetadata = class {};
globalThis.Audio = class {};

// 桩掉原生桥：把 configure/update/fail 暴露给测试，并记录命令（播放意图的独立证据）。
const bridge = { update: null, fail: null, commands: [], paused: true };
class FakeNativeAudio {
  constructor(config, update, fail) {
    bridge.config = config; bridge.update = update; bridge.fail = fail;
    this.ready = Promise.resolve();
    this.paused = true;
  }
  refresh() { return Promise.resolve(); }
  sync() { return Promise.resolve(); }
  command(action) {
    bridge.commands.push(action);
    if (action === 'play') { this.paused = false; bridge.paused = false; }
    if (action === 'pause') { this.paused = true; bridge.paused = true; }
    return Promise.resolve({});
  }
  play() { return this.command('play'); }
  pause() { void this.command('pause'); }
  load() {}
  removeAttribute() {}
  dispose() {}
}
const { ViteNodeRunner } = await import('vite-node/client');
const original = ViteNodeRunner.prototype.dependencyRequest;
ViteNodeRunner.prototype.dependencyRequest = function (id, fsPath, callstack) {
  const sid = String(id), sp = String(fsPath);
  if (sid === '$env/dynamic/public' || sp.includes('env/dynamic/public')) return Promise.resolve({ env: {} });
  if (sp.endsWith('/native-audio.ts') || sid.endsWith('/native-audio')) return Promise.resolve({ NativeAudio: FakeNativeAudio, usesNativeAudio: () => true });
  return original.call(this, id, fsPath, callstack);
};
const P = await import('../src/lib/player.svelte.ts');

const audioA = { id: 'bn-a', file: 'bn-a.opus', opus: 'bn-a.opus', title: 'A', startAt: 1794000000, duration: 100, lyrics: [], monthId: '2026-11' };
const audioB = { id: 'bn-b', file: 'bn-b.opus', opus: 'bn-b.opus', title: 'B', startAt: 1794000600, duration: 100, lyrics: [], monthId: '2026-11' };
const entry = (id, audio) => ({ queueEntryId: id, audio });
const queueItem = (id, audio) => ({ id, audio, url: audio.opus, title: audio.title, key: audio.title });
P.player.playlist = [entry('entry-a', audioA), entry('entry-b', audioB)];
P.player.pos = 0;
P.playAudio(audioA); // 选中 A → playCurrent：新曲幕、发送 play 命令

let sequence = 0;
const snapshot = over => ({
  queue: [queueItem('entry-a', audioA), queueItem('entry-b', audioB)],
  pos: 0, history: [], redo: [], played: [], shuffle: false, skipSame: true, repeatOne: false, rate: 1,
  revision: '', sequence: ++sequence, position: 0, duration: 100, playing: true, loading: false, error: '',
  sleepFired: false, sleepUntil: null, sleepStarted: null, sleepMode: 'off', afterTrack: false,
  sleepRevision: '', supportsCustomSleep: true, sleepCustomVersion: 1,
  sleepCustom: { holdPercent: 90, endDb: -12, exponent: 0.5, tailPercent: 30 },
  ...over,
});
const publish = over => bridge.update(snapshot(over));
// 回前台/重连：原生侧 getState 后把权威快照推回来，等价于 NativeAudio.onVisibility → accept → applyNativeState。
const foreground = over => publish(over);

step(P.player.error === '' && P.player.track?.queueEntryId === 'entry-a', 'new track starts with a clean banner');
publish({ playing: true });
step(P.player.playing === true && P.player.error === '', 'healthy native playback shows no banner');

// 场景 1：健康播放期间原生仍回传过期错误（旧壳）→ 横幅必须不出现
publish({ playing: true, error: '加载失败' });
step(P.player.error === '' && P.player.playing === true, 'stale error while playing is never rendered');

// 真正的现行失败：停着 + 原生报错 → 可见，并保持到被解决
publish({ playing: false, error: '音频连接失败' });
step(P.player.error === '音频连接失败' && /音频连接失败/.test(P.player.error), 'current failure stays visible');
publish({ playing: false, error: '音频连接失败' });
step(P.player.error === '音频连接失败', 'repeated current failure still visible');
publish({ playing: true, error: '' });
step(P.player.error === '' && P.player.playing === true, 'resolved playback clears the banner');

// 场景 2：失败 → 显式暂停 → 重新联网/回前台 → 不重放已作废的失败、不自行开播
publish({ playing: false, error: '加载失败' });
step(P.player.error === '加载失败', 'failure visible before the explicit pause');
P.notePauseIntent();
step(P.player.error === '', 'explicit pause drops the superseded failure');
const playsBeforePause = bridge.commands.filter(c => c === 'play').length;
bridge.paused = true;
publish({ playing: false, error: '' }); // 暂停态快照
foreground({ playing: false, error: '加载失败' }); // 回前台 getState：旧壳仍带着那条错误
step(P.player.error === '', 'reconnect/foreground while paused cannot re-show the superseded failure');
step(bridge.commands.filter(c => c === 'play').length === playsBeforePause, 'reconnect while paused starts no audio');
step(P.player.playing === false && P.player.loading === false, 'playback intent stays paused independently of the banner');

// 用户重新点播放 → 新的失败才允许显示
P.notePlayIntent();
step(P.player.error === '', 'resuming intent alone shows no banner');
bridge.fail('音频恢复失败', false);
step(P.player.error === '音频恢复失败', 'a genuine failure after resuming intent shows');
publish({ playing: true, error: '' });
step(P.player.error === '' && P.player.playing === true, 'recovered playback clears that failure');

// 换曲：旧曲的任何失败都不能挂到新曲上；新曲仍能显示自己的失败
publish({ playing: false, error: '加载失败' });
step(P.player.error === '加载失败', 'old track failure visible');
P.playAudio(audioB);
step(P.player.track?.queueEntryId === 'entry-b' && P.player.error === '', 'switching track clears the old banner');
bridge.fail('新曲失败', false);
step(P.player.error === '新曲失败', 'the new track can report its own current failure');

// 原生后台切曲（快照 pos 变化）：身份跟着换，旧横幅作废
publish({ pos: 0, playing: false, error: '上一首失败' });
step(P.player.error === '上一首失败', 'failure of the current native item shows');
publish({ pos: 1, playing: false, error: '' });
step(P.player.track?.queueEntryId === 'entry-b' && P.player.error === '', 'native track change supersedes the previous banner');
foreground({ pos: 1, playing: true, error: '' });
step(P.player.error === '' && P.player.playing === true, 'foreground snapshot of healthy playback stays clean');

// 停止当前曲：横幅一并清空（页面另有一层 !player.track 的守卫）
P.stopCurrent();
step(P.player.track === null && P.player.error === '', 'stopping the current track clears the banner');

console.log(`playback banner: ${checks} checks passed (pure state machine + player wiring: late/superseded failures, explicit pause, reconnect while paused, healthy playback, genuine failure retention)`);
process.exit(0);
