import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeAudio } from '../src/lib/native-audio.ts';
// Source assertions only: this runner does not compile Swift or exercise iOS SDKs.
const swift = readFileSync(new URL('../ios/App/App/NativePlayback.swift', import.meta.url), 'utf8');
const restore = swift.slice(swift.indexOf('private func restoredQueue('), swift.indexOf('private func valid('));
// issue #25 真机：清空必须让原生真的丢掉曲目——空队列不能依赖 id 比较就跳过 loadCurrent。
assert.ok(/if self\.queue\.isEmpty \{\s*self\.loadCurrent\(autoplay: false\)\s*\}/.test(swift), 'an empty configure always stops and detaches the native item (explicit clear)');
assert.ok(/let rawQueue = call\.getArray\("queue"\) \?\? \[\]/.test(swift), 'an empty queue is decoded as an explicit clear instead of being rejected by the per-item guard');
assert.ok(swift.includes('if rawQueue.isEmpty {'), 'empty queues bypass per-item URL validation');
assert.ok(restore.indexOf('saved["queueJSON"]') < restore.indexOf('saved["queue"]'), 'valid JSON queue wins over legacy queue');
assert.ok(restore.includes('JSONSerialization.jsonObject(with: data)') && restore.includes('valid(items) {'));
assert.ok(restore.includes('if let items = saved["queue"] as? [[String: Any]], valid(items) { return items }'), 'invalid/missing JSON falls back without remapping legacy identity or metadata');
const validation = swift.slice(swift.indexOf('private func valid('), swift.indexOf('@objc func configure'));
for (const field of ['monthId', '["audio"]', 'startAt']) assert.ok(!validation.includes(field), 'legacy queues need no invented audio metadata or date');
assert.ok(swift.includes('let items = restoredQueue(saved)'));
for (const key of ['pos', 'rate', 'shuffle', 'skipSame', 'history', 'redo', 'played', 'sleepRevision', 'sleepUntil', 'sleepStarted', 'sleepMode', 'afterTrack', 'position']) {
  assert.ok(swift.slice(swift.indexOf('let items = restoredQueue(saved)'), swift.indexOf('private func restoredQueue(')).includes('saved["' + key + '"]'), 'restore retains ' + key);
}
const persist = swift.slice(swift.indexOf('private func persist()'));
assert.ok(persist.includes('guard let data = try? JSONSerialization.data(withJSONObject: queue) else { return }'));
assert.ok(persist.indexOf('guard let data') < persist.indexOf('saved.removeValue(forKey: "queue")'));
assert.ok(persist.indexOf('saved["queueJSON"] = data') < persist.indexOf('UserDefaults.standard.set'), 'only persist a completely encoded migration');
const listeners = new Map();
globalThis.document = { hidden: false, removeEventListener() {}, addEventListener: (type, fn) => listeners.set(type, fn) };
const fixture = id => ({ id, file:id+'.wav', opus:id+'.opus', title:id, startAt:1, duration:null, lyrics:[], monthId:'2026-01' });
const queue = [{ audio: fixture('a'), id: 'entry-a', url: 'https://audio.example/a.opus', title: 'A', key: 'A' }, { audio: fixture('a'), id: 'entry-b', url: 'https://audio.example/b.opus', title: 'B', key: 'B' }];
let config = { queue, pos: 0, shuffle: false, skipSame: true, history: [], redo: [], played: ['A'], rate: 1, sleepRevision: '', sleepUntil: null, sleepStarted: null, sleepMode: 'off', afterTrack: false };
let state = { ...config, queue: [], pos: -1, revision: '', sequence: 0, position: 0, duration: 0, playing: false, loading: false, error: '', sleepFired: false };
let receive;
const calls = [];
let release;
let failNext = false;
let commandGate;
const driver = {
  async addListener(_, fn) { receive = fn; return { remove: async () => {} }; },
  async getState() { return { ...state }; },
  async configure(options) {
    calls.push('configure-start');
    if (release) await new Promise(resolve => { release.resolve = resolve; });
    state = { ...state, ...options, sequence: state.sequence + 1, duration: 120 };
    calls.push('configure-end'); return { ...state };
  },
  async command({ action, value }) {
    calls.push(action);
    if (commandGate) await new Promise(resolve => { commandGate.resolve = resolve; });
    if (failNext) { failNext = false; throw new Error('interrupted'); }
    if (action === 'play') state.playing = true;
    if (action === 'pause') state.playing = false;
    if (action === 'seek') state.position = value;
    return { ...state, sequence: ++state.sequence };
  }
};
let current;
const errors = [];
const errorLoading = [];
const audio = new NativeAudio(() => structuredClone(config), value => { current = value; }, (message, loading) => { errors.push(message); errorLoading.push(loading); }, driver);
await audio.ready;
assert.equal(queue[0].audio.id, queue[1].audio.id);
assert.notEqual(queue[0].id,queue[1].id);
release = {};
const loading = audio.sync(true);
const playing = audio.play();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(calls, ['configure-start'], 'play must wait for queue delivery');
release.resolve(); release = null;
await Promise.all([loading, playing]);
assert.equal(audio.paused, false);
assert.equal(current.queue[0].audio.monthId,'2026-01');
assert.deepEqual(calls, ['configure-start', 'configure-end', 'play']);
const oldState = { ...current };
config.pos = 1;
await audio.sync(true);
receive({ ...oldState, sequence: 100000 });
assert.equal(current.pos, 1, 'late event from previous queue revision must be ignored');
let ended = 0;
audio.addEventListener('ended', () => ended++);
state = { ...state, pos: 0, playing: true, history: [1], position: 18, sequence: state.sequence + 1 };
receive(state);
assert.equal(current.pos, 0, 'native background advance updates UI index');
assert.equal(audio.currentTime, 18);
assert.equal(ended, 0, 'native completion must not trigger a second JS queue advance');
state = { ...state, playing: false, position: 23, sequence: state.sequence + 1 };
listeners.get('visibilitychange')();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(audio.paused, true, 'foreground reconciles external pause');
assert.equal(audio.currentTime, 23);
audio.currentTime = 60;
await audio.play();
assert.equal(audio.currentTime, 60);
assert.equal(audio.paused, false);
receive({ ...state, playing: false, loading: true, sequence: ++state.sequence });
assert.equal(audio.paused, false, 'buffering remains pausable through the regular playback bar');
failNext = true;
await assert.rejects(audio.play(), /interrupted/);
await audio.play();
assert.equal(errors.at(-1), 'interrupted', 'native errors are surfaced without poisoning later commands');
state = { ...state, position: 37, sequence: state.sequence + 1 };
await audio.refresh();
assert.equal(audio.currentTime, 37, 'catalog reconciliation queries current state, not stale bootstrap state');
console.log('native audio: serialization, stale events, background advance, foreground reconciliation, seek and recovery passed');

const stableQueue = current.queue;
const stableHistory = current.history;
const { queue: omittedQueue, history: omittedHistory, redo: omittedRedo, played: omittedPlayed, ...progress } = state;
receive({ ...progress, position: 61, sequence: ++state.sequence });
assert.equal(audio.currentTime, 61, 'compact progress updates position');
assert.equal(current.queue, stableQueue, 'compact progress retains the cached queue');
assert.equal(current.history, stableHistory, 'compact progress retains history');
receive({ ...progress, revision: 'unknown', position: 99, sequence: state.sequence + 100 });
assert.equal(audio.currentTime, 61, 'delta from an unknown revision cannot corrupt the current snapshot');
const priorErrors = errors.length;
receive({ ...progress, error: 'offline', sequence: ++state.sequence });
receive({ ...progress, error: 'offline', sequence: ++state.sequence });
assert.equal(errors.length, priorErrors + 1, 'unchanged errors are emitted only once');
console.log('native audio: compact progress, cached catalog, revision isolation and error deduplication passed');

receive({ ...progress, error: 'reconnecting', loading: true, playing: false, position: 61, duration: 120, sequence: ++state.sequence });
assert.equal(errorLoading.at(-1), true, 'recoverable errors retain the native loading state');
assert.equal(audio.paused, false, 'recovery remains pausable without toggling the play button');
receive({ ...progress, error: '', loading: false, playing: true, position: 62, duration: 120, sequence: ++state.sequence });
assert.equal(current.error, '');
assert.equal(audio.currentTime, 62);
console.log('native audio: recoverable error keeps loading and clears on recovered state passed');

commandGate = {};
const blocked = audio.command('pause');
await new Promise(resolve => setTimeout(resolve, 0));
const queuedSync = audio.sync();
state = { ...state, playing: true, loading: false, position: 83, sequence: ++state.sequence };
receive(state);
assert.equal(audio.currentTime, 83, 'pending configuration must not reject native recovery events');
state = { ...state, position: 84, sequence: ++state.sequence };
const configCalls = calls.filter(call => call === 'configure-start').length;
listeners.get('visibilitychange')();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(audio.currentTime, 84, 'foreground reads bypass blocked mutation commands');
assert.equal(calls.filter(call => call === 'configure-start').length, configCalls, 'foreground must not configure or restart native playback');
config.pos = 0;
commandGate.resolve(); commandGate = null;
await Promise.all([blocked, queuedSync]);
assert.equal(current.pos, 0, 'queued sync reads current configuration at dispatch, not enqueue time');
const resumed = { ...state, playing: true, loading: false, position: 85, sequence: ++state.sequence };
receive(resumed);
receive({ ...resumed, playing: false, position: 0, sequence: resumed.sequence - 1 });
assert.equal(audio.currentTime, 85, 'late foreground response cannot rewind newer native progress');
assert.equal(audio.paused, false);
console.log('native audio: deferred sync, native recovery, foreground reconciliation and stale responses passed');

receive({ ...resumed, playing: false, position: 0 });
assert.equal(audio.currentTime, 85, 'duplicate event/command response is applied only once');
assert.equal(audio.paused, false);

// —— issue #25 真机回归：显式清空必须送出「调用时冻结」的空队列；清空前的在途快照
//    （pause/seek 的 publish）不得先把队列写回 UI，再被派发时重读后原样送回原生。 ——
{
  const base = { shuffle: false, skipSame: true, history: [], redo: [], played: [], rate: 1, sleepRevision: '', sleepUntil: null, sleepStarted: null, sleepMode: 'off', afterTrack: false };
  let nativeState = { ...base, queue: [queue[0]], pos: 0, revision: 'r0', sequence: 5, position: 7, duration: 120, playing: true, loading: false, error: '', sleepFired: false };
  const sent = []; const applied = []; let push;
  const clearDriver = {
    async addListener(_, fn) { push = fn; return { remove: async () => {} }; },
    async getState() { return { ...nativeState }; },
    async configure(options) { sent.push(structuredClone(options)); nativeState = { ...nativeState, ...options, sequence: nativeState.sequence + 1 }; return { ...nativeState }; },
    async command({ action }) { if (action === 'pause') nativeState = { ...nativeState, playing: false, sequence: nativeState.sequence + 1 }; return { ...nativeState }; }
  };
  let liveConfig = { ...base, queue: [queue[0]], pos: 0 };
  const cleared = new NativeAudio(() => structuredClone(liveConfig), s => applied.push(s), () => {}, clearDriver);
  await cleared.ready;
  const clearing = cleared.clear({ ...base, queue: [], pos: -1 });
  // Web 状态被旧快照回填：adapter 仍必须发调用时冻结的空队列，而不是派发时重读的满队列。
  liveConfig = { ...base, queue: [queue[0]], pos: 0 };
  const appliedBefore = applied.length;
  push({ ...nativeState, revision: 'r0', queue: [queue[0]], pos: 0, playing: false, position: 0, sequence: 99 });
  assert.equal(applied.length, appliedBefore, 'pre-clear revisions cannot repopulate the UI while a clear is pending');
  await clearing;
  assert.equal(sent.at(-1).queue.length, 0, 'explicit clear sends the frozen empty queue, not a re-read snapshot');
  assert.equal(sent.at(-1).replace, true, 'explicit clear asks native to replace the queue');
  assert.equal(applied.at(-1).queue.length, 0, 'the cleared snapshot is applied after the empty configure');
  assert.equal(cleared.src, '', 'no source remains after an explicit clear');
  push({ ...nativeState, revision: 'r0', queue: [queue[0]], pos: 0, sequence: 200 });
  assert.equal(applied.at(-1).queue.length, 0, 'late pre-clear snapshots still cannot resurrect the queue');
  cleared.dispose();
  console.log('native audio: explicit clear freezes an empty queue and drops pre-clear snapshots passed');
}

// —— AVPlayer 磁盘缓存接线：源码契约（本机不编译 Swift；行为断言见 scripts/test-native-cache.swift，
//    编译与真机验证仍待 Xcode/iPhone）——
const load = swift.slice(swift.indexOf('private func loadCurrent('), swift.indexOf('private func start(recovering:'));
assert.ok(load.includes('AnyunCacheKey.hash(url.absoluteString)'), 'cache key derives from the stable queue URL');
assert.ok(load.includes('localPlaybackURL(forKey: key)'), 'loadCurrent prefers a validated local file');
assert.ok(load.includes('url.scheme == "https"'), 'only stable HTTPS reaches AVPlayer/cache lookup; file URLs are never opened');
assert.ok(load.includes('loadGeneration += 1') && load.includes('prefetchTask?.cancel()'), 'each load invalidates older async results');
assert.ok(load.includes('attach(AVPlayerItem(url: url)'), 'uncached playback streams the stable URL immediately (no download-first regression)');
const attach = swift.slice(swift.indexOf('private func attach('), swift.indexOf('private func startPrefetch('));
assert.ok(attach.includes('audio.replaceCurrentItem(with: item)') && attach.includes('if at > 0 { seek(at) }') && attach.includes('_ = start(recovering: recovering)'), 'cache and stream paths share identical attach/seek/autoplay behaviour');
const prefetch = swift.slice(swift.indexOf('private func startPrefetch('), swift.indexOf('private static func keyPrefix('));
assert.ok(prefetch.includes('downloadFileOnce(key: key, expectedMediaEpoch: expectedEpoch)'), 'streaming playback kicks a parallel full-file download into AnyunDiskCache');
assert.ok(prefetch.includes('loadGeneration == generation'), 'late prefetch results are generation-guarded (cannot override a later track)');
assert.ok(!prefetch.includes('replaceCurrentItem') && !prefetch.includes('playImmediately') && !prefetch.includes('audio.play'), 'download completion never re-attaches items or auto-plays over a user pause');
assert.ok(prefetch.includes('离线且未缓存，无法播放'), 'offline cache miss gets an explicit Chinese message');
const start = swift.slice(swift.indexOf('private func start(recovering:'), swift.indexOf('private func pause()'));
assert.ok(start.includes('case .streaming(let key, let url) = playbackSource'), 'prefetch targets only the current streaming track');
assert.ok(start.includes('!prefetchAttempted') && swift.includes('prefetchAttempted = false; skipLocalForCurrentTrack = false'), 'one prefetch attempt per explicit selection, transient failure can retry on reselection');
const disk = readFileSync(new URL('../ios/App/App/AnyunDiskCache.swift', import.meta.url), 'utf8');
assert.ok(disk.includes('if !leasesSwept { releasePlaybackLeases(); leasesSwept = true }'), 'disk actor sweeps leftover leases before first lookup');
assert.ok(swift.includes('AnyunPlaybackCache.shared.releaseAllLeases()'), 'empty/guard failure releases lease references');
assert.ok(!swift.includes('expiresAt'), 'signed delivery targets/expiry never appear in native playback state');
assert.ok(/if recovering, let duration = audio\.currentItem\?\.duration/.test(load), 'freeze recovery keeps lastKnownDuration');
console.log('native audio: AVPlayer disk-cache wiring source contract passed (compile/device verification pending Xcode)');

// Custom sleep capability is opt-in; absence from an older installed shell must
// not turn "custom" into the native formula's legacy gentle fallback.
const custom = { holdPercent: 90, endDb: -12, exponent: .25, tailPercent: 30 };
config = { ...config, sleepMode: 'custom', sleepCustomVersion: 1, sleepCustom: custom, sleepUntil: 61000, sleepStarted: 1000, sleepRevision: 'custom-one' };
assert.equal(audio.supportsCustomSleep, false, 'missing capability is old-shell unsupported');
const beforeCustom = calls.filter(c => c === 'configure-start').length;
await assert.rejects(audio.sync(), /不支持自定义/);
assert.equal(calls.filter(c => c === 'configure-start').length, beforeCustom, 'never sends unsupported custom to an old shell');
config.sleepMode = 'steady';
await audio.sync();
assert.equal(current.sleepMode, 'steady', 'old shells continue accepting all presets');
state = { ...state, supportsCustomSleep: true, sequence: ++state.sequence };
receive(state);
assert.equal(audio.supportsCustomSleep, true);
config = { ...config, sleepMode: 'custom', sleepCustom: { ...custom }, sleepCustomVersion: 1 };
await audio.sync();
assert.deepEqual(current.sleepCustom, custom, 'native configuration receives detached running snapshot');
assert.equal(current.sleepRevision, 'custom-one');
const receivedSnapshot = current.sleepCustom;
const { queue: q2, history: h2, redo: r2, played: p2, ...deltaCustom } = state;
receive({ ...deltaCustom, position: 31, sequence: ++state.sequence });
assert.deepEqual(current.sleepCustom, receivedSnapshot, 'compact progress retains running custom parameters');
const { sleepCustom: omittedCustom, sleepCustomVersion: omittedVersion, ...oldDelta } = deltaCustom;
receive({ ...oldDelta, sequence: ++state.sequence });
assert.deepEqual(current.sleepCustom, receivedSnapshot, 'optional omitted fields retain known snapshot');
audio.dispose();
const restoredAudio = new NativeAudio(() => structuredClone(config), s => { current = s; }, m => errors.push(m), driver);
await restoredAudio.ready;
assert.deepEqual(current.sleepCustom, custom, 'cold adapter reads native-restored custom snapshot');
assert.equal(current.sleepRevision, 'custom-one', 'native-restored revision preserved');
assert.equal(restoredAudio.supportsCustomSleep, true);
restoredAudio.dispose();
console.log('native audio: opt-in custom capability, old-shell refusal/preset compatibility, snapshot/delta/cold restore passed');

// —— issue #6 裁决②：恢复完全由事件驱动，位置未推进不是失败 ——
const between = (from, to) => {
  const a = swift.indexOf(from), b = swift.indexOf(to);
  assert.ok(a >= 0 && b > a, `expected ${from} before ${to}`);
  return swift.slice(a, b);
};
const recovery = between('private func checkRecovery()', 'private func noteHealthyPlayback(');
assert.ok(!/currentTime\(\)\.seconds/.test(recovery) && !/lastPosition \+ 0\.05/.test(recovery),
  'checkRecovery has no position-progress health branch');
assert.ok(!/lastPosition = position/.test(recovery), 'recovery no longer advances lastPosition');
assert.ok(recovery.includes('stallDetectedAt') && recovery.includes('failureDetectedAt'),
  'recovery is driven by failure/stall events');
assert.ok(recovery.includes('guard confirmed != nil || stalled != nil else { return }'),
  'no event means no recovery scheduling');
assert.ok(recovery.includes('recoveryAttempts >= 8'), 'the hard cap of 8 attempts stays');
assert.ok(recovery.includes('NativeRetry.delay(attempt: recoveryAttempts, confirmedFailure: confirmed != nil'),
  'NativeRetry backoff still schedules the retry');
assert.ok(recovery.includes('loadCurrent(autoplay: true, at: lastPosition, recovering: true)'),
  'retry reloads at the sampled anchor');
const observer = between('timeObserver = audio.addPeriodicTimeObserver', 'let sleepTimer = Timer(');
assert.ok(observer.includes('self.audio.timeControlStatus == .playing') && observer.includes('self.lastPosition = time.seconds'),
  'lastPosition is sampled in the 0.25s time observer, gated on .playing');
assert.ok(between('private func seek(', 'private func visit(').includes('lastPosition = max(0, seconds)'),
  'seek still anchors lastPosition');
assert.ok(/lastPosition = at; lastProgressAt = Date\(\); failureDetectedAt = nil; stallDetectedAt = nil/.test(swift),
  'loadCurrent still anchors lastPosition and resets both signals');
const control = between('controlObserver = audio.observe', 'timeObserver = audio.addPeriodicTimeObserver');
assert.ok(control.includes('if self.audio.timeControlStatus == .playing { self.noteHealthyPlayback() }'),
  'the .playing transition is the only health judgement');
const healthy = between('private func noteHealthyPlayback()', 'private func diagnostic(');
assert.ok(healthy.includes('failureDetectedAt = nil') && healthy.includes('stallDetectedAt = nil') && healthy.includes('errorMessage = ""'),
  'resumed playback clears the failure anchors and the banner');
assert.ok(healthy.includes('recoveryAttempts = 0'), 'resumed playback resets the bounded retry counter');
const stalled = between('if name == AVPlayerItem.failedToPlayToEndTimeNotification', 'notifications.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification');
assert.ok(stalled.includes('self.stallDetectedAt = Date()'), 'playbackStalled is recorded as a stall event');
assert.ok(swift.includes('bufferObserver = item.observe(\\.isPlaybackBufferEmpty'), 'playbackBufferEmpty is observed per item');
assert.ok(between('bufferObserver = item.observe(', 'if at > 0 { seek(at) }').includes('self.stallDetectedAt = Date()'),
  'buffer exhaustion feeds the same stall signal');
assert.ok(between('private func pause()', 'private func seek(').includes('errorMessage = ""'),
  'explicit pause clears the superseded errorMessage');
assert.ok(swift.includes('"error": playing ? "" : errorMessage'), 'publish never carries a stale error while playing healthily');
console.log('native audio: issue #6 event-driven recovery source contract passed (no position-progress branch, sampled anchor, cap 8, event-driven clear)');

// —— issue #23：确认重载后的原生对账 ——
// 页面重载时原生进程与 AVPlayer 都活着，只有 WebView 里的 JS 全新启动。这里用「同一原生状态、
// 全新 NativeAudio 实例」模拟重载：只准 getState 读回，一次应用；不准 configure/play 造出第二条音频会话。
const reloadQueue = [
  { audio: fixture('ra'), id: 'reload-a', url: 'https://audio.example/ra.opus', title: 'A', key: 'A' },
  { audio: fixture('rb'), id: 'reload-b', url: 'https://audio.example/rb.opus', title: 'B', key: 'B' },
];
let reloadNative = {
  queue: reloadQueue, pos: 1, shuffle: false, skipSame: true, repeatOne: false,
  history: [0], redo: [], played: ['A'], rate: 1.25,
  sleepRevision: 'reload-sleep', sleepUntil: null, sleepStarted: null, sleepMode: 'off', afterTrack: false,
  revision: 'native-alive', sequence: 5000,
  position: 42.5, duration: 210, playing: true, loading: false, error: '', sleepFired: false, supportsCustomSleep: true,
};
const reloadCalls = [], reloadConfigs = [];
let reloadReceive;
const reloadDriver = {
  async addListener(_, fn) { reloadReceive = fn; return { remove: async () => {} }; },
  async getState() { reloadCalls.push('getState'); return structuredClone(reloadNative); },
  async configure(options) {
    reloadCalls.push('configure'); reloadConfigs.push(structuredClone(options));
    reloadNative = { ...reloadNative, ...options, sequence: reloadNative.sequence + 1, duration: 210 };
    return structuredClone(reloadNative);
  },
  async command({ action, value }) {
    reloadCalls.push('command:' + action);
    if (action === 'play') reloadNative.playing = true;
    if (action === 'pause') reloadNative.playing = false;
    if (action === 'seek') reloadNative.position = value;
    if (action === 'rate') reloadNative.rate = value;
    return { ...structuredClone(reloadNative), sequence: ++reloadNative.sequence };
  },
};

let reloadSnapshot, reloadUpdates = 0, reloadPlays = 0, reloadPauses = 0;
const reloadErrors = [];
const reloadConfig = () => ({
  queue: structuredClone(reloadQueue), pos: reloadNative.pos, shuffle: reloadNative.shuffle,
  skipSame: reloadNative.skipSame, history: [...reloadNative.history], redo: [...reloadNative.redo],
  played: [...reloadNative.played], rate: reloadNative.rate, sleepRevision: 'reload-sleep',
  sleepUntil: null, sleepStarted: null, sleepMode: 'off', afterTrack: false,
});
const reloadAudio = new NativeAudio(
  reloadConfig,
  s => { reloadSnapshot = s; reloadUpdates++; },
  m => reloadErrors.push(m), reloadDriver);
reloadAudio.addEventListener('play', () => reloadPlays++);
reloadAudio.addEventListener('pause', () => reloadPauses++);
await reloadAudio.ready;
assert.deepEqual(reloadCalls, ['getState'], 'reload bootstrap reads native state once and never configures/plays/seeks');
assert.equal(reloadUpdates, 1, 'the restored snapshot is applied exactly once');
assert.equal(reloadSnapshot.pos, 1);
assert.deepEqual(reloadSnapshot.queue.map(q => q.id), ['reload-a', 'reload-b'], 'queue identity and order survive the reload');
assert.equal(reloadAudio.src, 'https://audio.example/rb.opus');
assert.equal(reloadAudio.currentTime, 42.5, 'elapsed position is recovered from native state');
assert.equal(reloadAudio.duration, 210);
assert.equal(reloadAudio.playbackRate, 1.25);
assert.equal(reloadAudio.paused, false, 'play state is recovered, not reset');
assert.equal(reloadSnapshot.playing, true);
assert.deepEqual(reloadSnapshot.history, [0]);
assert.deepEqual(reloadSnapshot.played, ['A']);
assert.equal(reloadPlays, 1, 'exactly one play notification; no second audio session is started');
assert.equal(reloadPauses, 0);
assert.deepEqual(reloadErrors, [], 'reload reconciliation surfaces no error');
console.log('native audio: confirmed reload recovers queue, index, position, rate and play state from one getState without reconfiguring');

// 重载后目录迟到（setPlayerCatalog → refresh）：只重新读状态，不能 configure（那会让原生重载当前曲）。
await reloadAudio.refresh();
assert.equal(reloadAudio.currentTime, 42.5);
assert.deepEqual(reloadCalls, ['getState', 'getState'], 'post-reload catalog refresh never reconfigures native playback');
assert.equal(reloadNative.playing, true, 'refresh keeps native playback running');

// 重载前在途的迟到事件、以及重复的启动快照，都不能把状态倒回去或应用两次。
const { queue: reloadOmitQ, history: reloadOmitH, redo: reloadOmitR, played: reloadOmitP, ...reloadProgress } = reloadNative;
reloadReceive({ ...reloadProgress, revision: 'native-before-reload', position: 3, sequence: 4999 });
assert.equal(reloadAudio.currentTime, 42.5, 'delta from before the reload is dropped');
reloadReceive(structuredClone(reloadNative));
assert.equal(reloadAudio.currentTime, 42.5, 'duplicate bootstrap snapshot is applied only once');
reloadReceive({ ...reloadProgress, position: 44, sequence: 5001 });
assert.equal(reloadAudio.currentTime, 44, 'native progress after reload is applied once');
assert.equal(reloadAudio.paused, false);

// 暂停态重载：恢复位置但绝不自动开播；随后的设置同步必须复用同一原生会话。
reloadNative = { ...reloadNative, playing: false, loading: false, position: 77, sequence: reloadNative.sequence + 10 };
let pausedSnapshot, pausedUpdates = 0, pausedPlays = 0;
const pausedAudio = new NativeAudio(
  reloadConfig,
  s => { pausedSnapshot = s; pausedUpdates++; }, () => {}, reloadDriver);
pausedAudio.addEventListener('play', () => pausedPlays++);
await pausedAudio.ready;
assert.equal(pausedSnapshot.playing, false);
assert.equal(pausedAudio.paused, true, 'a reloaded paused session stays paused');
assert.equal(pausedAudio.currentTime, 77);
assert.equal(pausedUpdates, 1);
assert.equal(pausedPlays, 0, 'reload never auto-starts playback');
await pausedAudio.refresh();
assert.equal(pausedAudio.paused, true, 'post-reload refresh cannot resume a paused session');
const configures = reloadCalls.filter(c => c === 'configure').length;
await pausedAudio.sync();
assert.equal(reloadCalls.filter(c => c === 'configure').length, configures + 1, 'a settings sync after reload sends exactly one configure');
assert.equal(reloadConfigs.at(-1).pos, reloadNative.pos);
assert.deepEqual(reloadConfigs.at(-1).queue.map(q => q.id), ['reload-a', 'reload-b'], 'post-reload configure keeps the native queue identity');
assert.equal(reloadNative.playing, false, 'same-session configure neither starts nor pauses native audio');
assert.ok(!reloadCalls.some(c => c === 'command:play' || c === 'command:pause' || c === 'command:seek'), 'reload path issues no transport command');
pausedAudio.dispose(); reloadAudio.dispose();
console.log('native audio: paused reload stays paused, late/duplicate deltas drop, post-reload sync reuses the same native session');

// Swift 侧源码契约：重载后同队列/同曲 configure 不重载 item，冷启动按存档位置暂停恢复。
const configureBody = between('@objc func configure(', '@objc func command(');
assert.ok(configureBody.includes('let previous = self.currentID'));
assert.ok(configureBody.includes('if call.getBool("replace") == true || previous != self.currentID')
  && configureBody.includes('self.loadCurrent(autoplay: false)'),
  'configure reloads the item only when the queue is replaced or the current track changes');
assert.ok(!configureBody.includes('start(') && !configureBody.includes('audio.play('),
  'a same-track configure cannot start a second audio session');
assert.ok(!configureBody.includes('wantsPlayback = true'), 'same-track configure cannot resurrect playback intent');
const coldRestore = between('if let saved = UserDefaults.standard.dictionary(forKey: savedKey)', 'private func restoredQueue(');
assert.ok(coldRestore.includes('loadCurrent(autoplay: false, at: saved["position"] as? Double ?? 0)'),
  'cold start restores the saved position without autoplay');
assert.ok(coldRestore.includes('sleepState.configure(revision: saved["sleepRevision"]'),
  'cold start keeps a valid wall-clock sleep countdown');
assert.ok(!coldRestore.includes('start('), 'cold start never auto-plays');
const getStateBody = between('@objc func getState(', 'private var currentID');
assert.ok(!getStateBody.includes('loadCurrent') && !getStateBody.includes('start('),
  'getState is a pure read for the reloaded page');
console.log('native audio: issue #23 reload reconciliation source contract passed (same-track configure is inert, cold restore paused at saved position)');
