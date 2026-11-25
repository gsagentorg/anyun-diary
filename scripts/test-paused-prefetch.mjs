/**
 * 暂停预取回归（issue #7）：暂停态下补齐「当前曲 + 计划下一首」的网页音频缓存，
 * 绝不出声、绝不推进播放头；随机模式的下一首在预取时定下、推进时消费同一选择。
 *
 *   vite-node scripts/test-paused-prefetch.mjs
 *
 * 假 CacheStorage / 假 fetch / 假 Audio（与 test-web-offline、test-player-ops 同款桩），
 * 断言的是行为与缓存实况，不是字符串。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// —— 环境注入（必须先于模块加载） ——
const LS = new Map();
const ls = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => void LS.set(k, String(v)),
  removeItem: (k) => void LS.delete(k),
};
const windowListeners = new Map();
globalThis.localStorage = ls;
globalThis.window = {
  localStorage: ls,
  addEventListener(name, fn) { const list = windowListeners.get(name) ?? []; list.push(fn); windowListeners.set(name, list); },
  removeEventListener() {},
};
globalThis.location = { href: 'https://app.test/diary' };
const docListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener(name, fn) { const list = docListeners.get(name) ?? []; list.push(fn); docListeners.set(name, list); },
  removeEventListener() {},
};
const media = { metadata: undefined, playbackState: 'none', setActionHandler() {}, setPositionState() {} };
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: media, onLine: true }, configurable: true });
globalThis.MediaMetadata = class {};

const audioElements = [];
class AudioStub {
  constructor() {
    this.paused = true; this.currentTime = 0; this.src = ''; this.duration = 120; this.playbackRate = 1;
    this.volume = 1; this.muted = false; this.error = null; this.plays = 0; this.pauses = 0;
    this.listeners = new Map();
    audioElements.push(this);
  }
  addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
  removeEventListener() {}
  load() {}
  setAttribute() {}
  getAttribute() { return this.src; }
  removeAttribute() { this.src = ''; this.currentTime = 0; }
  play() { this.plays++; this.paused = false; for (const fn of this.listeners.get('play') ?? []) fn(); return Promise.resolve(); }
  pause() { this.pauses++; this.paused = true; for (const fn of this.listeners.get('pause') ?? []) fn(); }
}
globalThis.Audio = AudioStub;

// —— 假 CacheStorage ——
class FakeCache {
  constructor(name) { this.name = name; this.entries = new Map(); }
  make(u) {
    const { buf, headers } = this.entries.get(u);
    const res = new Response(buf, { status: 200, headers });
    Object.defineProperty(res, 'url', { value: u });
    return res;
  }
  async match(req) { const u = String(req); return this.entries.has(u) ? this.make(u) : undefined; }
  async matchAll() { return [...this.entries.keys()].map((u) => this.make(u)); }
  async keys() { return [...this.entries.keys()].map((u) => new Request(u)); }
  async put(req, res) {
    const u = String(req);
    const buf = new Uint8Array(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    this.entries.set(u, { buf, headers });
  }
  async delete(req) { return this.entries.delete(String(req)); }
}
class FakeCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) { if (!this.caches.has(name)) this.caches.set(name, new FakeCache(name)); return this.caches.get(name); }
  async has(name) { return this.caches.has(name); }
  async delete(name) { return this.caches.delete(name); }
  async keys() { return [...this.caches.keys()]; }
}
globalThis.caches = new FakeCacheStorage();

const cacheMod = await import('../src/lib/web-audio-cache.ts');
const {
  acquireCachedAudio, getWebAudioEntryState, getWebCacheStats, __resetWebAudioCacheStateForTest,
} = cacheMod;
const playerMod = await import('../src/lib/player.svelte.ts');
const {
  player, step, clearQueue, playAt, removeAt, setPlayMode, getPrefetchPlan, prefetchForOffline, getAudio,
} = playerMod;

const AUDIO_BODY = 'OGGSYNTHAUDIO'.repeat(2000);
const bodyBytes = new TextEncoder().encode(AUDIO_BODY).byteLength;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, msg) => { for (let i = 0; i < 400; i++) { if (await fn()) return; await sleep(10); } throw Error('timeout: ' + msg); };

function freshEnv() {
  globalThis.caches = new FakeCacheStorage();
  __resetWebAudioCacheStateForTest();
  LS.clear();
  audioElements.length = 0;
  for (const a of audioElements) a.plays = 0;
}
function goodFetch() {
  const calls = [];
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    return new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg', 'content-length': String(bodyBytes) } });
  };
  return calls;
}
/** 不理会 abort 的闸门（模拟「清空后迟到的响应体」） */
function gatedFetch() {
  const waiting = [];
  globalThis.fetch = (u) => new Promise((resolve) => { waiting.push({ url: String(u), settle: resolve }); });
  return waiting;
}

const hex = (c) => c.repeat(64);
const H = ['1', '2', '3', '4', '5', '6'].map((c) => hex(c));
function makeTracks(n = 3, titles) {
  return Array.from({ length: n }, (_, i) => ({
    queueEntryId: 'plan-entry-' + i,
    audio: {
      id: 'plan-audio-' + i,
      file: 'plan-' + i + '.opus',
      opus: 'audio/' + H[i] + '.opus',
      title: titles?.[i] ?? 'Plan fixture ' + i,
      startAt: 1794000000 + i * 60,
      duration: 120,
      lyrics: [],
      monthId: '2026-11',
    },
  }));
}
const keyOf = (t) => 'https://app.test/api/audio/' + t.audio.opus.split('/')[1];
const stateOf = (t) => getWebAudioEntryState(keyOf(t));

/** 直接摆状态（不经过 playCurrent，模拟「暂停中已有当前曲」） */
function load(list, pos, mode = 'sequential') {
  player.playlist = list;
  player.pos = pos;
  player.track = list[pos] ?? null;
  player.mode = mode;
  player.shuffle = mode === 'random';
  player.playing = false;
  player.loading = false;
  player.history = [];
  player.shuffleRedo = [];
  player.playedTitles = [];
  player.error = '';
}

/** 可预测的 Math.random：返回序列中的值并计数 */
function stubRandom(seq) {
  const original = Math.random;
  const record = { calls: 0 };
  Math.random = () => { record.calls++; return seq[(record.calls - 1) % seq.length]; };
  record.restore = () => { Math.random = original; };
  return record;
}

async function section(name, fn) {
  try { await fn(); console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name); throw e; }
}

console.log('paused prefetch:');

// —— 1. 暂停联网恢复：当前曲 + 计划下一首都进缓存，音频零动作 ——
await section('paused prefetch caches current + planned next without starting audio', async () => {
  freshEnv();
  const list = makeTracks(3);
  load(list, 0);
  const a = getAudio();
  a.src = '/api/audio/' + H[0] + '.opus';
  a.currentTime = 37;
  a.plays = 0;
  const before = { plays: a.plays, src: a.src, time: a.currentTime, paused: a.paused };
  const calls = goodFetch();
  // 模拟「连接恢复」：真实 online 事件由 bindPrefetchTriggers 接入
  for (const fn of windowListeners.get('online') ?? []) fn();
  await until(async () => (await stateOf(list[0])) === 'cached' && (await stateOf(list[1])) === 'cached', 'both cached via online event');
  await prefetchForOffline();
  eq(await stateOf(list[0]), 'cached', 'current track fully cached');
  eq(await stateOf(list[1]), 'cached', 'planned next fully cached');
  eq(await stateOf(list[2]), 'none', 'only one planned next is prefetched');
  eq(calls.length, 2, 'exactly two downloads (current + next)');
  eq([a.plays, a.src, a.currentTime, a.paused], [before.plays, before.src, before.time, true], 'no audio action at all');
  eq([player.playing, player.pos, player.loading], [false, 0, false], 'no playback/head advance');
  eq(player.error, '', 'no banner from prefetch');
  eq(new Set(calls).size, 2, 'downloads dedupe by stable key');
  // 已缓存后再调：零新增下载
  await prefetchForOffline();
  eq(calls.length, 2, 'cached entries are reused, no re-download');
});

// —— 2. 随机模式：预取时定下下一首，推进消费同一选择 ——
await section('shuffle plan is reused by the next advance', async () => {
  freshEnv();
  const list = makeTracks(6);
  load(list, 2, 'random');
  const rand = stubRandom([0.02, 0.97, 0.5, 0.5, 0.5, 0.5]);
  goodFetch();
  try {
    await prefetchForOffline();
    const plan = getPrefetchPlan();
    ok(!!plan, 'a plan exists after prefetch');
    ok(plan.index !== 2, 'plan is not the current index');
    const draws = rand.calls;
    step(1);
    eq(player.pos, plan.index, 'advance lands on the prefetched choice');
    eq(rand.calls, draws, 'advance did not draw again');
    eq(player.track, list[plan.index], 'advance switched to the planned track');
  } finally { rand.restore(); }
});

// —— 3. 回退栈顶优先：计划复用它（step(1) 只弹顶消费，保留其余回退历史） ——
await section('shuffle plan prefers a valid redo entry', async () => {
  freshEnv();
  const list = makeTracks(6);
  load(list, 1, 'random');
  player.shuffleRedo = [2, 4];
  goodFetch();
  await prefetchForOffline();
  eq(getPrefetchPlan()?.index, 4, 'planned next is the redo top');
  step(1);
  eq(player.pos, 4, 'advance pops the redo entry');
  eq(player.shuffleRedo, [2], 'only the top is consumed; remaining redo history kept');
  step(1);
  eq(player.pos, 2, 'next advance still follows the remaining redo stack');
  eq(player.shuffleRedo, [], 'redo stack fully consumed');
});

// —— 4. 计划失效：模式 / 队列 / 手动跳转 / 清空 ——
await section('plan invalidates on mode change, queue change, manual jump and clear', async () => {
  freshEnv();
  let list = makeTracks(5);
  load(list, 1, 'random');
  goodFetch();
  await prefetchForOffline();
  ok(!!getPrefetchPlan(), 'plan present');
  setPlayMode('sequential');
  eq(getPrefetchPlan(), null, 'mode change invalidates');
  await prefetchForOffline();
  eq(getPrefetchPlan()?.index, 2, 'sequential plan = pos + 1');

  freshEnv();
  list = makeTracks(5);
  load(list, 2, 'random');
  goodFetch();
  await prefetchForOffline();
  ok(!!getPrefetchPlan(), 'plan present again');
  removeAt(0);
  eq(getPrefetchPlan(), null, 'queue removal invalidates');

  await prefetchForOffline();
  ok(!!getPrefetchPlan(), 'replanned for the new queue');
  playAt(0);
  eq(getPrefetchPlan(), null, 'manual jump invalidates');
  eq(player.pos, 0, 'manual jump happened');

  await prefetchForOffline();
  ok(!!getPrefetchPlan(), 'plan for the new current track');
  clearQueue();
  eq(getPrefetchPlan(), null, 'clear invalidates');
  eq([player.playlist.length, player.pos, player.track], [0, -1, null], 'queue really cleared');
});

// —— 5. 顺序/单曲循环：计划 = pos + 1（到队尾就没有） ——
await section('sequential / repeat-one plan is pos + 1 only when it exists', async () => {
  freshEnv();
  const list = makeTracks(3);
  for (const mode of ['sequential', 'repeat-one']) {
    load(list, 1, mode);
    goodFetch();
    await prefetchForOffline();
    eq(getPrefetchPlan()?.index, 2, mode + ': next is pos + 1');
    load(list, 2, mode);
    await prefetchForOffline();
    eq(getPrefetchPlan(), null, mode + ': no next at the queue end');
  }
});

// —— 6. 失败的刷新不毁掉已有的完整缓存 ——
await section('failed download keeps an existing complete entry', async () => {
  freshEnv();
  const list = makeTracks(3);
  load(list, 0);
  goodFetch();
  await prefetchForOffline();
  const bytes = (await getWebCacheStats()).bytes;
  eq(bytes > 0, true, 'seed entries present');
  // 网络坏掉：再预取一次，缓存条目必须原样保留、仍可离线取用
  globalThis.fetch = async () => { throw TypeError('offline'); };
  await prefetchForOffline();
  eq(await stateOf(list[0]), 'cached', 'complete entry survives a failing refresh');
  eq((await getWebCacheStats()).bytes, bytes, 'bytes unchanged');
  const handle = await acquireCachedAudio(keyOf(list[0]));
  ok(!!handle && handle.url.startsWith('blob:'), 'entry still serves a blob');
  handle.release();
  eq(player.error, '', 'no banner while paused');
  // 未缓存的新曲下载失败：只是没有缓存，不出声、不留半条
  freshEnv();
  load(makeTracks(3), 0);
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  await prefetchForOffline();
  eq(await stateOf(list[0]), 'none', 'failed download stores nothing');
  eq((await getWebCacheStats()).entries, 0, 'cache stays clean');
  eq(player.error, '', 'no banner from a failed prefetch');
});

// —— 7. 下载途中清空队列：迟到响应不得复活队列/缓存 ——
await section('clearing the queue during a download cannot resurrect it', async () => {
  freshEnv();
  const list = makeTracks(3);
  load(list, 0);
  const a = getAudio();
  a.plays = 0;
  const waiting = gatedFetch();
  const job = prefetchForOffline();
  await until(() => waiting.length === 1, 'download started');
  clearQueue();
  eq([player.playlist.length, player.pos, player.track], [0, -1, null], 'queue cleared while downloading');
  eq(waiting.length, 1, 'next track never started downloading');
  waiting[0].settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  await job;
  await sleep(20);
  eq((await getWebCacheStats()).entries, 0, 'late response cannot store an entry');
  eq([player.playlist.length, player.pos, player.track], [0, -1, null], 'download did not resurrect the queue');
  eq([a.plays, player.playing, player.error], [0, false, ''], 'no audio start and no banner');
  eq(await stateOf(list[0]), 'none', 'cleared queue left no cached track');
});

// —— 8. 清理缓存与在途预取：web-audio-cache 的 clear 语义仍然生效 ——
await section('cache clear aborts an in-flight prefetch', async () => {
  freshEnv();
  const list = makeTracks(3);
  load(list, 2); // 队尾：没有下一首，整轮只有一条下载
  const waiting = gatedFetch();
  const job = prefetchForOffline();
  await until(() => waiting.length === 1, 'download started');
  const cleared = await cacheMod.clearWebAudioCache();
  ok(cleared.entries === 0, 'nothing was stored yet');
  waiting[0].settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  await job;
  eq((await getWebCacheStats()).entries, 0, 'cleared cache stays cleared');
  eq(await stateOf(list[2]), 'none', 'nothing resurrected');
});

// —— 9. 原生侧现状（源码级断言，未编译未真机） ——
await section('native playback prefetches only the current streaming track', async () => {
  const swift = fs.readFileSync(path.resolve(import.meta.dirname, '../ios/App/App/NativePlayback.swift'), 'utf8');
  ok(swift.includes('single prefetch lane') || swift.includes('private var prefetchTask: Task<Void, Never>?'), 'native has a single prefetch lane');
  ok(swift.includes('downloadFileOnce(key: key, expectedMediaEpoch: expectedEpoch)'), 'prefetch targets only the current key');
  ok(!/prefetch[A-Za-z]*\(\s*next/i.test(swift), 'native has no next-track prefetch');
  const ts = fs.readFileSync(path.resolve(import.meta.dirname, '../src/lib/player.svelte.ts'), 'utf8');
  ok(/prefetchEligible[\s\S]{0,200}!usesNativeAudio\(\)/.test(ts), 'web scheduler never runs in the native shell');
});

console.log(`paused prefetch: ${checks} checks passed`);
process.exit(process.exitCode ?? 0);
