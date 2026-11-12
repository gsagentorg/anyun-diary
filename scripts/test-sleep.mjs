import assert from 'node:assert/strict';
import { sleepGain, sleepCurvePath, sleepCurvePoint, sleepProgress, sleepStage, sleepSecondsFromHandle, sleepMinutesFromHandle, SLEEP_MODES, isSleepMode, MIN_SLEEP_SECONDS, MIN_SLEEP_MINUTES } from '../src/lib/sleep-curves.ts';
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
const { sleep, player, startSleep, cancelSleep, adjustSleepEnd, syncSleep, getAudio, setSleepPreset, initSleep, onTrackEnded, step } = await import('../src/lib/player.svelte.ts');
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
const { buildRecTracks } = await import('../src/lib/types.ts');
const diary = (await import('../src/lib/data.json')).default;
player.playlist = diary.recordings.flatMap(buildRecTracks).slice(0, 2);
player.pos = 0; player.track = player.playlist[0];
lastContext.state = 'suspended'; events.length = 0;
step(1);
ok(events.indexOf('resume') >= 0 && events.indexOf('resume') < events.indexOf('play'), 'track-selection gesture resumes engine before playback');
ok(player.pos === 1 && decodeURIComponent(getAudio().src).includes(player.playlist[1].clip.opus), 'actual track switched');
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

console.log(`sleep: ${checks} checks passed`);
