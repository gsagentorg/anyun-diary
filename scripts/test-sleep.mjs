import assert from 'node:assert/strict';
import { sleepGain, sleepCurvePath, sleepCurvePoint, sleepProgress, sleepStage, sleepSecondsFromHandle, sleepMinutesFromHandle, sleepSeekProgress, sleepSeekLimit, sleepTrackHit, SLEEP_MODES, SLEEP_TRACK_HALF_WIDTH, isSleepMode, MIN_SLEEP_SECONDS, MIN_SLEEP_MINUTES } from '../src/lib/sleep-curves.ts';
import { SleepAudio } from '../src/lib/sleep-audio.ts';
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
for (const { id } of SLEEP_MODES) {
  ok(sleepGain(id, 0) === 1, `${id}: unity start`);
  ok(sleepGain(id, 1) === (id === 'off' ? 1 : 0), `${id}: endpoint`);
  let previous = 1;
  for (let i = 0; i <= 1000; i++) {
    const value = sleepGain(id, i / 1000);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= previous + 1e-10, `${id}: monotone bounded ${i}`);
    previous = value;
  }
  checks++;
  ok(!/NaN|Infinity/.test(sleepCurvePath(id)), `${id}: finite plot`);
}
ok(sleepGain('late', 2 / 3) === 1, 'late holds first 2/3');
ok(sleepGain('companion', 0.25) < sleepGain('gentle', 0.25), 'companion quieter early');
ok(Math.abs(sleepGain('steady', 0.5) - 10 ** (-30 / 20)) < 1e-10, 'steady is linear dB');
ok(sleepGain('gentle', -1) === 1 && sleepGain('gentle', 2) === 0, 'clamped progress');
ok(sleepGain('gentle', NaN) === 1 && !isSleepMode('oops'), 'invalid input safe');

// —— 新增曲线：慢起加速 + 末端从仍可听清的音量直接切断（无微弱尾声）——
// 下降"加速"要在分贝域看：线性增益越接近零压缩越强，会掩盖末段更陡的事实。
const dbDrop = (mode, a, b) => 20 * Math.log10(sleepGain(mode, a) / sleepGain(mode, b));
for (const id of ['cliff', 'hold', 'stair']) {
  ok(SLEEP_MODES.some((mode) => mode.id === id), `${id}: registered`);
  ok(sleepGain(id, 0.999) > 0.05, `${id}: still audible right before the cut`);
  ok(sleepGain(id, 1) === 0, `${id}: jumps to silence at the deadline`);
}
ok(sleepGain('cliff', 0.2) > 0.97, 'cliff barely drops at the start');
ok(sleepGain('cliff', 0.25) > sleepGain('gentle', 0.25), 'cliff holds louder than gentle early');
ok(dbDrop('cliff', 0, 0.25) < dbDrop('cliff', 0.5, 0.75), 'cliff accelerates as it descends');
ok(dbDrop('cliff', 0.5, 0.75) < dbDrop('cliff', 0.75, 1 - 1e-9), 'cliff steepest at the end');
ok(sleepGain('hold', 0.8) === 1, 'hold keeps full volume through 80%');
ok(Math.abs(sleepGain('hold', 0.995) - 10 ** (-12 / 20)) < 1e-3, 'hold settles near -12 dB before cutting');
ok(Math.abs(sleepGain('stair', 0.3) - sleepGain('stair', 0.45)) < 1e-12, 'stair holds each level steady');
ok(sleepGain('stair', 0.3) < sleepGain('stair', 0.1), 'stair steps down');
ok(sleepGain('stair', 0.8) < sleepGain('stair', 0.6) && sleepGain('stair', 0.99) > 0.05, 'stair ends audible then cuts');
// —— 形态约定逐条对齐 UI 文案（describe 与曲线必须说同一件事）——
const dbGain = (mode, t) => 20 * Math.log10(sleepGain(mode, t));
// cliff：起手近乎不动，末段 -14.4 dB 仍可听清后切断。
ok(Math.abs(dbGain('cliff', 0.25)) < 0.25, 'cliff barely moves through the first quarter: ' + dbGain('cliff', 0.25).toFixed(3));
ok(Math.abs(dbGain('cliff', 0.9999) + 14.4) < 0.02, 'cliff cuts from -14.4 dB, not a whisper: ' + dbGain('cliff', 0.9999).toFixed(2));
// hold：82% 之前一字不降，之后降到 -12 dB 并保持到切断。
ok(sleepGain('hold', 0.82) === 1, 'hold keeps unity exactly through 82%');
ok(Math.abs(dbGain('hold', 0.97) + 12) < 1e-9, 'hold settles to exactly -12 dB by 97%');
ok(sleepGain('hold', 0.99) === sleepGain('hold', 0.97), 'hold keeps that level steady until the cut');
// stair：恰好四级 0/-6/-12/-18 dB，每级平台都稳定。
for (const [t, expectedDb] of [[0.1, 0], [0.3, -6], [0.6, -12], [0.8, -18]]) {
  ok(Math.abs(dbGain('stair', t) - expectedDb) < 1e-9, `stair level at ${t} is ${expectedDb} dB`);
}
// 唯一的跳变必须落在截止点上：界内相邻采样步长极小，最后一步才是悬崖。
for (const id of ['cliff', 'hold', 'stair', 'gentle', 'steady']) {
  let interior = 0;
  // 只看到 0.999 为止；最后一步（0.999→1）单独算，正是截止点上的跳变。
  for (let i = 0; i < 999; i++) interior = Math.max(interior, Math.abs(sleepGain(id, i / 1000) - sleepGain(id, (i + 1) / 1000)));
  const finalStep = sleepGain(id, 0.999) - sleepGain(id, 1);
  ok(interior < 0.05, `${id}: no interior discontinuity (max step ${interior.toFixed(4)})`);
  if (id === 'cliff' || id === 'hold' || id === 'stair') ok(finalStep > 0.1, `${id}: the only jump is at the deadline (${finalStep.toFixed(4)})`);
  else ok(finalStep < 0.001, `${id}: gradual modes close to zero without a step (${finalStep.toExponential(2)})`);
}
ok(sleepStage('cliff', 0.3) === '缓慢下降' && sleepStage('cliff', 0.7) === '加速下降' && sleepStage('cliff', 0.97) === '即将切断', 'cliff stages');
ok(sleepStage('hold', 0.5) === '保持音量' && sleepStage('hold', 0.9) === '末段轻降' && sleepStage('hold', 0.99) === '即将切断', 'hold stages');
ok(sleepStage('stair', 0.5) === '阶梯渐弱' && sleepStage('stair', 0.99) === '即将切断', 'stair stages');

// —— 拖动命中区：整条竖线（不只是一个点）——
ok(sleepTrackHit(90, 90), 'track hit on the marker line');
ok(sleepTrackHit(90 + SLEEP_TRACK_HALF_WIDTH - 0.01, 90), 'track hit at the edge of the band');
ok(sleepTrackHit(90 - SLEEP_TRACK_HALF_WIDTH + 0.01, 90), 'track hit on the left edge');
ok(!sleepTrackHit(90 + SLEEP_TRACK_HALF_WIDTH + 1, 90), 'track miss beyond the band');
ok(!sleepTrackHit(60, 90), 'track miss away from the line');
ok(!sleepTrackHit(NaN, 90) && !sleepTrackHit(90, NaN), 'invalid pointer never hits');
ok(sleepTrackHit(60, 90, 40), 'custom half width honoured');
ok(SLEEP_TRACK_HALF_WIDTH * 2 >= 26, 'hit band is wider than a dot');
ok(sleepSeekProgress(90) === 0.5 && sleepSeekProgress(-10) === 0 && sleepSeekProgress(999) === 1, 'seek progress from curve x');
ok(sleepSeekProgress(NaN) === 0, 'invalid seek x maps to start');
ok(sleepSeekLimit(60) === 0 && Math.abs(sleepSeekLimit(600) - 0.9) < 1e-12, 'seek limit keeps one minute');
ok(sleepSeekLimit(0) === 0 && sleepSeekLimit(NaN) === 0, 'seek limit safe on empty timers');

// Position and stage indicators share the exact geometry of the preview curve.
for (const { id } of SLEEP_MODES) {
  const point = sleepCurvePoint(id, 0.5);
  ok(point.x === 90 && point.y >= 4 && point.y <= 38, `${id}: halfway marker bounded`);
  ok(sleepCurvePath(id).includes(`L${point.x},${point.y}`), `${id}: marker lies on plotted curve`);
}
ok(sleepCurvePoint('gentle', -1).x === 0 && sleepCurvePoint('gentle', 2).x === 180, 'marker position clamped');
ok(sleepCurvePoint('gentle', NaN).y === 4, 'invalid marker position starts safely');
ok(sleepProgress(1800000, 1800) === 0, 'countdown start position');
ok(sleepProgress(1800000, 900) === 0.5, 'countdown half position');
ok(sleepProgress(1800000, 1620) === 0.1, 'ten-percent position avoids cancellation rounding');
ok(sleepProgress(1800000, 0) === 1 && sleepProgress(1800000, -10) === 1, 'countdown end clamped');
ok(sleepProgress(1800000, 1900) === 0, 'countdown early value clamped');
ok(sleepProgress(0, 0) === 0 && sleepProgress(NaN, 2) === 0 && sleepProgress(1000, NaN) === 0, 'invalid or inactive duration safe');
ok(sleepStage('late', 0.65) === '保持音量' && sleepStage('late', 2 / 3) === '渐弱中', 'late hold-to-fade boundary');
ok(sleepStage('companion', 0.249) === '降至轻声' && sleepStage('companion', 0.25) === '轻声尾段', 'companion early-to-tail boundary');
ok(sleepStage('gentle', 0.1) === '缓慢起步' && sleepStage('gentle', 0.5) === '渐弱中', 'gentle start and middle stages');
ok(sleepStage('steady', 0.5) === '匀速渐弱' && sleepStage('steady', 0.85) === '轻声尾段', 'steady middle and tail stages');
ok(sleepStage('gentle', 0.99) === '即将停止' && sleepStage('gentle', 1) === '已结束', 'closing and finished stages');
ok(sleepStage('off', 0.99) === '保持音量', 'hard stop never claims fading');

let now = 100000;
Date.now = () => now;
const timers = new Map();
let timerId = 0;
globalThis.setInterval = (fn) => { timers.set(++timerId, fn); return timerId; };
globalThis.clearInterval = (id) => timers.delete(id);
const events = [];
class AudioStub {
  crossOrigin = 'anonymous';
  paused = true; volume = 0.7; currentTime = 0; duration = 120; src = '';
  listeners = new Map();
  addEventListener(name, fn) { const handlers = this.listeners.get(name) ?? []; handlers.push(fn); this.listeners.set(name, handlers); }
  removeEventListener() {}
  load() {} removeAttribute() {} setAttribute() {}
  play() { events.push('play'); this.paused = false; for (const fn of this.listeners.get('play') ?? []) fn(); return Promise.resolve(); }
  pause() { events.push('pause'); this.paused = true; for (const fn of this.listeners.get('pause') ?? []) fn(); }
}
let graphCount = 0;
const curves = [];
const param = {
  value: 1,
  cancelScheduledValues() { events.push('cancel'); },
  setValueAtTime(v) { this.value = v; events.push(`gain:${v}`); },
  linearRampToValueAtTime(v) { this.value = v; },
  setValueCurveAtTime(values, time, duration) { curves.push({ values, time, duration }); this.value = values[0]; },
};
let lastContext;
class ContextStub {
  state = 'running'; currentTime = 0; destination = {};
  constructor() { lastContext = this; }
  resume() { events.push('resume'); this.state = 'running'; return Promise.resolve(); }
  createGain() { return { gain: param, connect() {} }; }
  createMediaElementSource() { graphCount++; return { connect() {} }; }
}
globalThis.AudioContext = ContextStub;
globalThis.Audio = AudioStub;
const storage = new Map();
globalThis.window = { localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }, addEventListener() {} };
globalThis.document = { visibilityState: 'visible', addEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: { setActionHandler() {}, setPositionState() {} } }, configurable: true });
globalThis.MediaMetadata = class {};
const { sleep, player, startSleep, cancelSleep, seekSleepProgress, adjustSleepEnd, syncSleep, getAudio, setSleepPreset, initSleep, onTrackEnded, step } = await import('../src/lib/player.svelte.ts');
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
setSleepPreset('gentle');
ok(storage.get('anyun-sleep-preset-v1') === 'gentle', 'preset persisted');
storage.set('anyun-sleep-preset-v1', 'late'); initSleep();
ok(sleep.preset === 'late', 'preset restored');
storage.set('anyun-sleep-preset-v1', 'invalid'); initSleep();
ok(sleep.preset === 'late', 'invalid stored preset ignored');
setSleepPreset('gentle');
startSleep(30); await settle();
const deadline = sleep.until;
ok(deadline === now + 1800000 && sleep.remaining === 1800, 'wall clock deadline');
ok(graphCount === 1 && curves.at(-1).values.length === 301, 'native automation scheduled');
ok(curves.at(-1).values[0] === 1 && curves.at(-1).values.at(-1) === 0, 'scheduled unity to zero');
now += 900000; syncSleep();
ok(sleep.until === deadline && sleep.remaining === 900, 'catch-up uses elapsed wall time');
ok(Math.abs(curves.at(-1).values[0] - sleepGain('gentle', 0.5)) < 1e-6, 'foreground reschedules from current gain');
setSleepPreset('late');
ok(sleep.mode === 'gentle', 'next selection does not mutate running curve');
getAudio().pause(); await getAudio().play();
ok(sleep.until === deadline, 'pause/play do not restart countdown');
player.playlist = [0, 1].map(i => ({ queueEntryId: 'sleep-entry-' + i, audio: { id: 'sleep-audio-' + i, file: 'sleep-' + i + '.opus', opus: 'sleep-' + i + '.opus', title: 'Sleep fixture ' + i, startAt: 1794000000 + i * 60, duration: 60, monthId: '2026-11', lyrics: [] } }));
player.pos = 0; player.track = player.playlist[0];
lastContext.state = 'suspended'; events.length = 0;
step(1);
ok(events.indexOf('resume') >= 0 && events.indexOf('resume') < events.indexOf('play'), 'track-selection gesture resumes engine before playback');
ok(player.pos === 1 && decodeURIComponent(getAudio().src).includes(player.playlist[1].audio.opus), 'actual track switched');
ok(sleep.until === deadline && graphCount === 1, 'track navigation does not recreate graph or timer');
now = deadline - 1; syncSleep();
ok(!sleep.fired && sleep.remaining === 1, 'not stopped half-second early');
events.length = 0;
now = deadline + 600000; syncSleep();
ok(sleep.fired && sleep.until === null && getAudio().paused, 'late wake stops immediately');
ok(events.indexOf('pause') < events.indexOf('gain:1'), 'pause happens before gain restore');
await getAudio().play();
ok(param.value === 1 && getAudio().volume === 0.7, 'next playback normal volume');
startSleep(1); await settle(); cancelSleep();
ok(sleep.until === null && param.value === 1 && graphCount === 1, 'cancel restores and graph reused');

// —— 终止语义：暂停中到期、渐弱中途取消、到期后重开新计划 ——
setSleepPreset('hold'); startSleep(2); await settle();
getAudio().pause();
now = sleep.until; syncSleep();
ok(sleep.fired && sleep.until === null && getAudio().paused, 'expiry while paused keeps playback paused');
ok(param.value === 1, 'expiry while paused restores full gain');
await getAudio().play();
ok(param.value === 1 && getAudio().volume === 0.7, 'play after a paused expiry is not attenuated');
setSleepPreset('stair'); startSleep(2); await settle();
now = sleep.until - 60000; syncSleep();
const midFade = param.value;
ok(midFade > 0.05 && midFade < 0.9, 'mid-run gain is attenuated before cancel: ' + midFade.toFixed(3));
cancelSleep();
ok(param.value === 1 && getAudio().volume === 0.7, 'cancel from a mid-fade restores normal volume');
ok(sleep.fired === false && sleep.remaining === 0, 'cancel is not an expiry and clears the countdown');
setSleepPreset('cliff'); startSleep(1); await settle();
ok(sleep.mode === 'cliff' && sleep.fired === false, 'restart after expiry applies the newly selected preset');
ok(sleep.progress === 0 && Math.abs(curves.at(-1).values[0] - 1) < 1e-9, 'restart schedules the new plan from unity');
cancelSleep();
ok(sleep.until === null && param.value === 1, 'restart block leaves no active timer');
startSleep(2); await settle(); const existing = sleep.until;
for (const invalid of [NaN, Infinity, -1, 0, 601]) startSleep(invalid);
ok(sleep.until === existing, 'invalid input does not destroy active timer');
startSleep(null, true);
ok(sleep.afterTrack && sleep.until === null, 'after-track has no fade');
onTrackEnded();
ok(sleep.fired && !sleep.afterTrack && getAudio().paused, 'after-track ends without next song');
setSleepPreset('off'); startSleep(1); await settle();
ok(sleep.mode === 'off' && param.value === 1, 'hard stop mode leaves gain alone');
cancelSleep();
setSleepPreset('gentle'); startSleep(1); await settle();
now = sleep.until;
await getAudio().play();
ok(getAudio().paused && sleep.fired && !player.playing, 'overdue play event is stopped before playing state');
startSleep(1); await settle();
now = sleep.until;
const positionBeforeEnd = player.pos;
onTrackEnded();
ok(sleep.fired && player.pos === positionBeforeEnd, 'deadline prevents auto-next on track end');
const baselineTimers = timers.size;
for (let i = 0; i < 4; i++) { startSleep(1); cancelSleep(); }
ok(timers.size === baselineTimers, 'no leaked sleep intervals');

// Non-CORS media must never enter an irreversible Web Audio graph.
const unsafeAudio = new AudioStub(); unsafeAudio.crossOrigin = null;
const unsafeEngine = new SleepAudio(unsafeAudio);
const graphBeforeUnsafe = graphCount;
ok((await unsafeEngine.prepare()).includes('兼容渐弱'), 'non-CORS media uses volume fallback');
ok(graphCount === graphBeforeUnsafe && unsafeAudio.volume === 0.7, 'non-CORS prepare preserves sound and creates no graph');
unsafeEngine.tick('gentle', 0);
ok(unsafeAudio.volume === 0.7, 'fade starts at original volume');
unsafeEngine.restore();

// No AudioContext: relative HTML volume fallback and honest unsupported notice.
delete globalThis.AudioContext;
const fallbackAudio = new AudioStub();
const fallback = new SleepAudio(fallbackAudio);
ok((await fallback.prepare()).includes('兼容渐弱'), 'fallback warning');
fallback.tick('steady', 0.5);
ok(Math.abs(fallbackAudio.volume - 0.7 * sleepGain('steady', 0.5)) < 1e-10, 'fallback multiplies original volume');
fallback.restore();
ok(fallbackAudio.volume === 0.7, 'fallback restores original volume');
class LockedAudio extends AudioStub {
  constructor() { super(); Object.defineProperty(this, 'volume', { get: () => 1, set: () => {} }); }
}
const locked = new SleepAudio(new LockedAudio());
ok((await locked.prepare()).includes('仅在到时停止'), 'read-only volume honestly degrades');

// Cancel while resume is pending: must never route the audio or arm the stale fade.
let release;
class DeferredContext extends ContextStub {
  state = 'suspended';
  resume() { return new Promise((resolve) => { release = () => { this.state = 'running'; resolve(); }; }); }
}
globalThis.AudioContext = DeferredContext;
const pending = new SleepAudio(new AudioStub());
const before = graphCount;
const preparation = pending.prepare(); pending.restore(); release(); await preparation;
ok(graphCount === before, 'cancelled async preparation does not route audio');
// Fade-curve handle: horizontal drag rescales the time axis, shape unchanged.
ok(sleepSecondsFromHandle(0, 1800) === 1800, 'handle: left edge keeps full duration');
ok(sleepSecondsFromHandle(180, 1800) === MIN_SLEEP_SECONDS, 'handle: right edge floors at 60s');
ok(sleepSecondsFromHandle(90, 1800) === 900, 'handle: halfway is half the time');
ok(sleepSecondsFromHandle(179.9, 1800) === 60, 'handle: near-right still floors at 60s');
ok(sleepSecondsFromHandle(-20, 1800) === 1800 && sleepSecondsFromHandle(400, 1800) === 60, 'handle: out-of-range input clamped');
ok(sleepSecondsFromHandle(NaN, 1800) === 1800, 'handle: invalid coordinate keeps full duration');
ok(sleepSecondsFromHandle(90, 0) === 60 && sleepSecondsFromHandle(90, NaN) === 60, 'handle: invalid duration falls back to the 60s floor');
ok(sleepMinutesFromHandle(0, 15) === 15, 'preview handle: full tier');
ok(sleepMinutesFromHandle(90, 15) === 8, 'preview handle: rounds to whole minutes');
ok(sleepMinutesFromHandle(45, 15) === 11, 'preview handle: rounds half down-to-nearest');
ok(sleepMinutesFromHandle(180, 15) === MIN_SLEEP_MINUTES, 'preview handle: one-minute floor');
ok(sleepMinutesFromHandle(NaN, 15) === 15 && sleepMinutesFromHandle(90, 0) === 1, 'preview handle: invalid input safe');

// Running timer: dragging the end keeps started/preset/mode and re-arms automation.
setSleepPreset('gentle'); startSleep(30); await settle();
const dragStart = sleep.until;
const dragStartedAt = sleep.started;
const beforeDragCurve = curves.length;
now = dragStart - 600000; syncSleep();
ok(sleep.remaining === 600, 'drag baseline: ten minutes left');
adjustSleepEnd(300);
ok(sleep.until === now + 300000 && sleep.remaining === 300, 'drag shortens wall-clock deadline');
ok(sleep.started === dragStartedAt && sleep.mode === 'gentle', 'drag preserves started/preset/mode semantics');
ok(sleep.fired === false, 'drag clears a fired flag');
ok(curves.length > beforeDragCurve, 'drag reschedules native automation');
const dragProgress = (now - dragStartedAt) / (sleep.until - dragStartedAt);
ok(Math.abs(curves.at(-1).values[0] - sleepGain('gentle', dragProgress)) < 1e-6, 'drag reschedule starts from current gain');
adjustSleepEnd(5);
ok(sleep.remaining === MIN_SLEEP_SECONDS && sleep.until === now + 60000, 'drag never goes below the 60s floor');
adjustSleepEnd(NaN);
ok(sleep.remaining === MIN_SLEEP_SECONDS, 'invalid drag distance ignored');
cancelSleep();
ok(sleep.plannedSeconds === 0 && sleep.until === null, 'cancel clears the planned window');

setSleepPreset('gentle'); startSleep(15); await settle();
seekSleepProgress(0.5);
ok(sleep.plannedSeconds === 900 && sleep.remaining === 450, '15-minute halfway retains 7m30');
ok(sleep.progress === 0.5 && sleep.until - sleep.started === 900000, 'point and time share stable duration');
ok(Math.abs(curves.at(-1).values[0] - sleepGain('gentle', 0.5)) < 1e-6, 'audio uses exact dot phase');
seekSleepProgress(0.95);
ok(sleep.remaining === MIN_SLEEP_SECONDS && Math.abs(sleep.progress - (1 - MIN_SLEEP_SECONDS / 900)) < 1e-9, 'drag stops at the one-minute floor');
seekSleepProgress(0.25);
ok(sleep.remaining === 675 && sleep.progress === 0.25, 'backwards seek restores earlier phase');
seekSleepProgress(1);
ok(sleep.until !== null && !sleep.fired && sleep.remaining === MIN_SLEEP_SECONDS, 'dragging to the end still leaves a minute (stop = cancel button)');
seekSleepProgress(NaN);
ok(sleep.until !== null && sleep.remaining === MIN_SLEEP_SECONDS, 'invalid seek input leaves the timer untouched');
cancelSleep();
ok(sleep.until === null, 'cancel clears the dragged timer');
console.log(`sleep: ${checks} checks passed`);
