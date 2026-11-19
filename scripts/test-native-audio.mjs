import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeAudio } from '../src/lib/native-audio.ts';
// Source assertions only: this runner does not compile Swift or exercise iOS SDKs.
const swift = readFileSync(new URL('../ios/App/App/NativePlayback.swift', import.meta.url), 'utf8');
const restore = swift.slice(swift.indexOf('private func restoredQueue('), swift.indexOf('private func valid('));
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
globalThis.document = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn) };
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
