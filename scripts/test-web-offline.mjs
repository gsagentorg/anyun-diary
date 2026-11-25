/**
 * 网页音频离线缓存回归测试（node 直跑，勿用浏览器）：
 *   node scripts/test-web-offline.mjs
 *
 * 用假 CacheStorage/假 fetch 模拟真实环境断言行为（不是字符串断言）：
 * 完整 200 入缓存、重载后离线命中、206/opaque/截断/失败不入缓存、
 * LRU/上限/quota、clear 与在途写入不复活、并发去重、取消、签名不进 key、
 * Blob 引用计数与 revoke、audio-renewal 集成（换曲/暂停/损坏回退）。
 */
import assert from 'node:assert/strict';

let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// —— 环境注入（必须先于模块使用） ——
const LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => void LS.set(k, String(v)),
  removeItem: (k) => void LS.delete(k),
  key: () => null,
  clear: () => LS.clear(),
};
globalThis.location = { href: 'https://app.test/diary' };

class FakeCache {
  constructor(name) { this.name = name; this.entries = new Map(); this.failQuota = 0; this.matchGate = null; }
  make(u) {
    const { buf, headers } = this.entries.get(u);
    const res = new Response(buf, { status: 200, headers });
    Object.defineProperty(res, 'url', { value: u });
    return res;
  }
  async match(req) {
    const u = String(req);
    if (!this.entries.has(u)) return undefined;
    const snapshot = this.make(u); // 读取时刻的响应副本：模拟“慢读”拿到旧字节
    if (this.matchGate) await this.matchGate;
    return snapshot;
  }
  async matchAll() { return [...this.entries.keys()].map((u) => this.make(u)); }
  async keys() { return [...this.entries.keys()].map((u) => new Request(u)); }
  async put(req, res) {
    if (this.failQuota > 0) { this.failQuota--; throw new DOMException('quota', 'QuotaExceededError'); }
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

// Blob URL 观测：记录 create/revoke，断言「正在播不撤销、切曲后及时回收」。
const liveBlobs = new Map();
const revokedBlobs = [];
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (b) => { const u = realCreate(b); liveBlobs.set(u, b); return u; };
URL.revokeObjectURL = (u) => { if (liveBlobs.delete(u)) revokedBlobs.push(u); else { try { realRevoke(u); } catch { /* 已撤销 */ } } };

const mod = await import('../src/lib/web-audio-cache.ts');
const {
  WEB_AUDIO_CACHE_NAME, DEFAULT_WEB_AUDIO_MAX_BYTES, WEB_AUDIO_MIN_BYTES, WEB_AUDIO_MAX_LIMIT,
  acquireCachedAudio, clearWebAudioCache, configureWebCacheOrigin, getWebAudioEntryState,
  getWebAudioCacheLimit, getWebCacheStats, invalidateCachedAudio, normalizeWebCacheKey,
  prepareWebAudio, setWebAudioCacheLimit, subscribeWebCacheEvents, webCacheAvailable,
  __resetWebAudioCacheStateForTest,
} = mod;
const { attachAudioRenewal } = await import('../src/lib/audio-renewal.ts');

const events = [];
subscribeWebCacheEvents((e) => events.push(e));

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const KEY1 = `https://app.test/api/audio/${H1}.opus`;
const KEY2 = `https://app.test/api/audio/${H2}.opus`;
const AUDIO_BODY = 'OGGSYNTHAUDIO'.repeat(2000); // 合成 fixture，无真实数据
const audioBytes = new TextEncoder().encode(AUDIO_BODY).byteLength;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, msg) => { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(10); } throw Error('timeout: ' + msg); };

function fakeStorageReset() {
  globalThis.caches = new FakeCacheStorage();
  __resetWebAudioCacheStateForTest();
  LS.clear();
}
function goodFetch(body = AUDIO_BODY) {
  let calls = [];
  globalThis.fetch = async (u, opts) => {
    calls.push(String(u));
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/ogg', 'content-length': String(new TextEncoder().encode(body).byteLength) } });
  };
  return () => calls;
}
function gatedFetch() {
  const waiting = [];
  globalThis.fetch = (u, opts) => new Promise((resolve, reject) => {
    const ab = () => reject(new DOMException(' aborted', 'AbortError'));
    opts?.signal?.addEventListener('abort', ab, { once: true });
    waiting.push({ url: String(u), resolve, reject, settle: (v) => { opts?.signal?.removeEventListener('abort', ab); resolve(v); } });
  });
  return waiting;
}
const plainResponse = ({ status = 200, type = 'basic', headers = {}, body = AUDIO_BODY }) => ({
  status,
  ok: status >= 200 && status < 300,
  type,
  headers: new Headers(headers),
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

async function section(name, fn) {
  try { await fn(); console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name); throw e; }
}

console.log('web offline cache:');

// —— 1. key 规范化：严格同源路由 / 跨域音频 / 凭证 / 签名剥离 ——
await section('normalize keys', async () => {
  eq(normalizeWebCacheKey(`/api/audio/${H1}.opus`), KEY1, 'relative same-origin → absolute key');
  eq(normalizeWebCacheKey(KEY1 + '?X-Amz-Signature=SECRETSIG&resolve=1#frag'), KEY1, 'signature never in key');
  eq(normalizeWebCacheKey('/api/audio/' + 'z'.repeat(64) + '.opus'), null, 'non-hex rejected');
  eq(normalizeWebCacheKey(`/api/audio/${H1.slice(0, 63)}.opus`), null, 'wrong length rejected');
  eq(normalizeWebCacheKey('/api/other/' + H1 + '.opus'), null, 'non-audio same-origin path rejected');
  eq(normalizeWebCacheKey('/'), null, 'root rejected');
  eq(normalizeWebCacheKey('https://user:pw@cdn.test/a/b.opus'), null, 'credentials rejected');
  eq(normalizeWebCacheKey('ftp://cdn.test/a.opus'), null, 'non-http rejected');
  eq(normalizeWebCacheKey('https://cdn.test/objects/x/' + H1 + '.opus?sig=S'), 'https://cdn.test/objects/x/' + H1 + '.opus', 'cross-origin audio allowed, query stripped');
  eq(normalizeWebCacheKey('https://cdn.test/page.html'), null, 'cross-origin non-audio rejected');
  configureWebCacheOrigin('https://alt.test');
  eq(normalizeWebCacheKey(`/api/audio/${H1}.opus`), `https://alt.test/api/audio/${H1}.opus`, 'injected origin resolves relatives');
  configureWebCacheOrigin(null);
  const savedLocation = globalThis.location;
  globalThis.location = undefined;
  eq(normalizeWebCacheKey(`/api/audio/${H1}.opus`), null, 'relative without any base → null (degrade, no throw)');
  globalThis.location = savedLocation;
});

// —— 2. 不可用环境降级（不抛、不影响播放地址返回） ——
await section('degrade without caches', async () => {
  eq(webCacheAvailable(), true, 'available with fake caches');
  const saved = globalThis.caches;
  delete globalThis.caches;
  eq(webCacheAvailable(), false, 'unavailable after removal');
  const p = await prepareWebAudio(KEY1);
  eq(p.url, KEY1, 'degrade returns original URL');
  eq(p.cached, false, 'degrade not cached');
  eq(await p.done, false, 'degrade done=false');
  const stats = await getWebCacheStats();
  eq(stats.supported, false, 'stats unsupported');
  globalThis.caches = saved;
});

// —— 3. 完整 200 → 缓存 → 命中 Blob → 模拟重载后仍命中（零二次下载） ——
await section('full-200 cache, blob hit, cold restart hit', async () => {
  fakeStorageReset();
  const calls = goodFetch();
  const first = await prepareWebAudio(KEY1 + '?sig=FIRST');
  eq(first.cached, false, 'miss first');
  eq(first.url, KEY1 + '?sig=FIRST', 'miss returns caller url');
  eq(first.stableUrl, KEY1, 'normalized key reported');
  eq(await first.done, true, 'background download completed');
  eq(calls().length, 1, 'exactly one download');
  let stats = await getWebCacheStats();
  eq([stats.entries, stats.bytes], [1, audioBytes], 'stats count bytes');
  eq(stats.maxBytes, DEFAULT_WEB_AUDIO_MAX_BYTES, 'default limit = 512MB like App');
  ok(!JSON.stringify([...globalThis.caches.caches.get(WEB_AUDIO_CACHE_NAME).entries.keys()]).includes('sig=FIRST'), 'signature not persisted');
  const cached = await prepareWebAudio(KEY1 + '?sig=SECOND');
  ok(cached.cached, 'second prepare hits');
  ok(cached.url.startsWith('blob:'), 'hit serves blob URL');
  eq(calls().length, 1, 'hit without network');
  cached.release();
  __resetWebAudioCacheStateForTest(); // 模拟页面重载：内存态全清
  const revived = await prepareWebAudio(KEY1);
  ok(revived.cached, 'cold restart hits persistent cache');
  ok(revived.url.startsWith('blob:'), 'cold restart serves blob');
  eq(calls().length, 1, 'cold restart uses zero network');
  eq(await getWebAudioEntryState(KEY1), 'cached', 'entry state cached');
  await until(() => revokedBlobs.length >= 1, 'unused blob revoked after grace');
  ok(revived.url.startsWith('blob:'), 'revoked-then-recreated still ok');
});

// —— 4. 不合格响应一律不缓存 ——
await section('reject 206 / opaque / truncated / empty / html / non-200', async () => {
  fakeStorageReset();
  const cases = [
    ['206 partial', plainResponse({ status: 206, headers: { 'content-type': 'audio/ogg' } })],
    ['opaque', plainResponse({ type: 'opaque', headers: { 'content-type': 'audio/ogg' } })],
    ['truncated', plainResponse({ headers: { 'content-type': 'audio/ogg', 'content-length': String(audioBytes + 999) } })],
    ['empty body', plainResponse({ body: '', headers: { 'content-type': 'audio/ogg', 'content-length': '0' } })],
    ['html content-type', plainResponse({ headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['404', new Response(null, { status: 404 })],
    ['network error', null],
  ];
  for (const [name, res] of cases) {
    const key = `https://app.test/api/audio/${(name.length * 7) % 10}c${'d'.repeat(62)}.opus`;
    globalThis.fetch = async () => { if (!res) throw TypeError('down'); return res; };
    const p = await prepareWebAudio(key);
    eq(p.cached, false, name + ': not playable from cache');
    eq(await p.done, false, name + ': done=false');
    eq(await getWebAudioEntryState(key), 'none', name + ': nothing stored');
  }
  const cache = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  eq(cache.entries.size, 0, 'zero rejected entries in CacheStorage');
  const stats = await getWebCacheStats();
  eq([stats.entries, stats.bytes], [0, 0], 'stats clean');
});

// —— 5. 并发去重与取消 ——
await section('dedupe + cancel', async () => {
  fakeStorageReset();
  const waiting = gatedFetch();
  const a = prepareWebAudio(KEY1);
  const b = prepareWebAudio(KEY1); // 同 key 并发 → 共享在途
  const [pa, pb] = [await a, await b];
  eq(waiting.length, 1, 'one shared in-flight download');
  eq(pa.cached, false, 'a miss');
  eq(pb.cached, false, 'b miss');
  waiting[0].settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  eq([await pa.done, await pb.done], [true, true], 'both waiters observe completion');
  let stats = await getWebCacheStats();
  eq(stats.entries, 1, 'single entry after dedupe');
  const signal = new AbortController();
  const waiting2 = gatedFetch();
  const c = await prepareWebAudio(KEY2, { signal: signal.signal });
  eq(c.cached, false, 'c miss');
  eq(waiting2.length, 1, 'c fetch started');
  signal.abort();
  eq(await c.done, false, 'cancelled download resolves false');
  eq(await getWebAudioEntryState(KEY2), 'none', 'cancelled writes nothing');
  stats = await getWebCacheStats();
  eq(stats.downloading, 0, 'slot released after cancel');
});

// —— 6. LRU 有界 + 上限持久化 + 非法值夹取 ——
await section('LRU bounded + limits', async () => {
  fakeStorageReset();
  eq(setWebAudioCacheLimit(1), WEB_AUDIO_MIN_BYTES, 'clamped to min');
  eq(setWebAudioCacheLimit(Number.MAX_SAFE_INTEGER), WEB_AUDIO_MAX_LIMIT, 'clamped to max');
  eq(setWebAudioCacheLimit(Number.NaN), DEFAULT_WEB_AUDIO_MAX_BYTES, 'invalid falls back to default');
  const limit = WEB_AUDIO_MIN_BYTES;
  eq(setWebAudioCacheLimit(limit), limit, 'limit applied');
  eq(LS.get('anyun-web-audio-limit-v1'), String(limit), 'limit persisted');
  const big = 'L'.repeat(400_000);
  const keys = [];
  for (let i = 0; i < 4; i++) {
    const key = `https://app.test/api/audio/${'e'.repeat(62)}0${i}.opus`;
    keys.push(key);
    goodFetch(big);
    const p = await prepareWebAudio(key);
    eq(await p.done, true, 'entry ' + i + ' cached');
    await sleep(5);
  }
  const stats = await getWebCacheStats();
  ok(stats.bytes <= limit, 'cache stays under limit: ' + stats.bytes);
  eq(await getWebAudioEntryState(keys[0]), 'none', 'oldest evicted');
  eq(await getWebAudioEntryState(keys[1]), 'none', 'second-oldest evicted');
  eq(await getWebAudioEntryState(keys[3]), 'cached', 'newest kept');
  ok(events.some((e) => e.type === 'evicted'), 'evicted event emitted');
  eq(getWebAudioCacheLimit(), limit, 'getter reflects');
});

// —— 7. quota 失败：逐出重试成功 / 实在放不下诚实放弃且不动播放 ——
await section('quota errors', async () => {
  fakeStorageReset();
  goodFetch();
  const warm = await prepareWebAudio(`https://app.test/api/audio/${'f'.repeat(64)}.opus`);
  eq(await warm.done, true, 'seed entry');
  const cache = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  cache.failQuota = 1;
  const retried = await prepareWebAudio(KEY1);
  eq(await retried.done, true, 'quota retry stores after evicting');
  eq(cache.entries.has(KEY1), true, 'entry present after retry');
  ok(events.some((e) => e.type === 'evicted'), 'eviction fired on quota');
  fakeStorageReset();
  const cache2 = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  cache2.failQuota = 999;
  const doomed = await prepareWebAudio(KEY2);
  eq(doomed.url, KEY2, 'still returns playable url');
  eq(await doomed.done, false, 'refuses gracefully');
  eq(cache2.entries.size, 0, 'nothing half-stored');
});

// —— 8. clear：计数、中止在途、不复活、清理后重新下载、在播 Blob 不撤销 ——
await section('clear semantics', async () => {
  fakeStorageReset();
  goodFetch();
  eq((await (await prepareWebAudio(KEY1)).done), true, 'key1 cached');
  const handle = await acquireCachedAudio(KEY1); // 在播 handle，clear 不得撤销
  ok(handle && handle.url.startsWith('blob:'), 'live handle acquired');
  const waiting = gatedFetch();
  const inflight = await prepareWebAudio(KEY2);
  eq(waiting.length, 1, 'key2 downloading');
  const cleared = await clearWebAudioCache();
  eq([cleared.entries, cleared.freedBytes], [1, audioBytes], 'clear reports');
  eq(await inflight.done, false, 'in-flight aborted');
  waiting[0].settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  await sleep(30);
  const cache = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  eq(cache.entries.size, 0, 'cleared stays cleared (no resurrection after late body)');
  eq(await getWebAudioEntryState(KEY1), 'none', 'cleared key not cached');
  ok(!revokedBlobs.includes(handle.url), 'playing handle not revoked by clear');
  const stats = await getWebCacheStats();
  eq(stats.entries, 0, 'stats zero');
  ok(events.some((e) => e.type === 'cleared'), 'cleared event');
  handle.release();
  await until(() => revokedBlobs.includes(handle.url), 'released handle revoked after grace');
});

// —— 9. 元数据不泄露签名：LRU 持久化内容干净 ——
await section('no signed urls in metadata', async () => {
  fakeStorageReset();
  goodFetch();
  const p = await prepareWebAudio(KEY1 + '?X-Amz-Signature=SUPERSECRET');
  eq(await p.done, true, 'stored');
  await sleep(900); // 等 LRU debounce 落盘
  const dump = JSON.stringify([...LS.entries()]);
  ok(!dump.includes('SUPERSECRET'), 'localStorage clean of signature');
  ok(!dump.includes('X-Amz'), 'localStorage keys are clean stable urls');
});

// —— 10. audio-renewal 集成：在线首播→后台缓存→离线命中→切曲 revoke→损坏回退 ——
await section('renewal integration', async () => {
  fakeStorageReset();
  revokedBlobs.length = 0;
  class Media extends EventTarget {
    src = ''; currentTime = 0; playbackRate = 1.5; volume = 0.4; muted = true; paused = true; error = null; plays = 0;
    getAttribute() { return this.src; }
    load() { this.currentTime = 0; queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    pause() { this.paused = true; }
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
  }
  let resolveCalls = 0;
  let cacheCalls = 0;
  globalThis.fetch = async (u, opts) => {
    const url = String(u);
    if (url.includes('?resolve=1')) { resolveCalls++; return Response.json({ url: 'https://cdn.test/signed-' + (opts?.tag ?? 'x') + '?X-Amz-Signature=S1', expiresAt: Date.now() + 60000 }); }
    if (url.startsWith('blob:')) throw TypeError('no fetch for blob');
    cacheCalls++;
    return new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } });
  };
  const errors = [];
  const m = new Media();
  attachAudioRenewal(m, () => 'entry', (msg) => errors.push(msg));
  m.src = KEY1; m.load(); await m.play();
  ok(m.src.includes('signed-') || m.src === KEY1, 'online playback started');
  eq(resolveCalls, 1, 'resolve fetched once');
  await until(async () => (await getWebAudioEntryState(KEY1)) === 'cached', 'background cache completed');
  eq(cacheCalls, 1, 'exactly one background download');
  m.pause(); await m.play();
  eq(resolveCalls, 1, 'resume no re-resolve');
  // 换曲 → 回来：完全离线（任何 fetch 都算违规）
  m.src = KEY2; m.load(); await m.play();
  await until(async () => (await getWebAudioEntryState(KEY2)) === 'cached', 'key2 cached');
  const before = { resolveCalls, cacheCalls };
  globalThis.fetch = async () => { throw TypeError('offline'); };
  m.src = KEY1; m.load();
  await m.play();
  ok(m.src.startsWith('blob:'), 'offline replay served from blob cache');
  eq({ resolveCalls, cacheCalls }, before, 'offline hit used zero network');
  ok(m.plays >= 4, 'play proceeded');
  eq(m.playbackRate, 1.5, 'rate preserved across cache swap');
  // 切走再切回：旧 Blob 进入回收但当前在播的不撤
  globalThis.fetch = async () => { throw TypeError('offline'); };
  m.src = KEY2; m.load(); await m.play();
  ok(m.src.startsWith('blob:'), 'key2 blob hit offline');
  const key1BlobStillLive = revokedBlobs.length; // key1 handle released at switch; grace 1.5s
  await until(() => revokedBlobs.length > key1BlobStillLive, 'previous track blob revoked after grace');
  ok(!revokedBlobs.includes(m.src), 'current playing blob NOT revoked');
  // Blob 播放损坏 → 作废条目 + 回退在线（恢复语义不回归）
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('?resolve=1')) { resolveCalls++; return Response.json({ url: 'https://cdn.test/signed-fresh', expiresAt: Date.now() + 60000 }); }
    return new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } });
  };
  m.dispatchEvent(new Event('error'));
  await until(() => !m.src.startsWith('blob:'), 'corrupt blob falls back to online url');
  ok(m.src.includes('signed-fresh'), 'recovered with fresh signed url');
  ok(resolveCalls >= before.resolveCalls + 1, 'fallback went through online resolve');
  await until(async () => ['cached', 'downloading'].includes(await getWebAudioEntryState(KEY2)), 'broken entry was invalidated then auto-repaired');
  eq(errors, [], 'no spurious failures during integration flow');
});

// —— 11. 并发下载上限 ——
await section('parallel download cap', async () => {
  fakeStorageReset();
  const waiting = gatedFetch();
  const keys = ['0', '1', '2'].map((d) => `https://app.test/api/audio/${d}${'9'.repeat(63)}.opus`);
  const promises = [];
  for (const key of keys) { const p = await prepareWebAudio(key); promises.push(p.done); await Promise.resolve(); }
  await sleep(20);
  eq(waiting.length, 2, 'at most 2 parallel cache downloads (third queued)');
  waiting[0].settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  const rest = waiting.slice(1); // 槽位移交后第三条才真正发起
  await until(() => waiting.length >= 3, 'queued download starts after slot freed');
  for (const rec of [...rest, waiting[2]]) rec.settle(new Response(AUDIO_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } }));
  eq(await Promise.all(promises), [true, true, true], 'all three cached');
});

// —— 12. invalidate 单独路径 ——
await section('invalidate', async () => {
  fakeStorageReset();
  goodFetch();
  eq(await (await prepareWebAudio(KEY1)).done, true, 'cached');
  await invalidateCachedAudio(KEY1 + '?noise=1');
  eq(await getWebAudioEntryState(KEY1), 'none', 'invalidated');
  const cache = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  eq(cache.entries.has(KEY1), false, 'removed from CacheStorage');
});

await section('concurrent byte bounds and clear during put', async () => {
  fakeStorageReset();setWebAudioCacheLimit(WEB_AUDIO_MIN_BYTES);
  globalThis.fetch = async () => new Response(new Uint8Array(400000),{headers:{'content-type':'audio/ogg'}});
  const ks=['a','b','c'].map(c=>'https://app.test/api/audio/'+c.repeat(64)+'.opus');
  const first = await prepareWebAudio(ks[0]); const second = await prepareWebAudio(ks[1]);
  await Promise.all([first.done,second.done]);
  globalThis.fetch = async () => new Response(new Uint8Array(900000),{headers:{'content-type':'audio/ogg'}});
  ok(await (await prepareWebAudio(ks[2])).done,'large item requires multiple evictions');
  const bounded = await getWebCacheStats();
  ok(bounded.bytes<=bounded.maxBytes && bounded.entries===1,'stored bytes never exceed limit after multi-eviction');
  await clearWebAudioCache();
  const cache=await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  const put=cache.put.bind(cache);let enter,release;
  const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  cache.put=async(...args)=>{enter();await gate;return put(...args);};
  const waiting=await prepareWebAudio(ks[0]);await entered;
  await clearWebAudioCache();release();
  eq(await waiting.done,false,'clear wins over a put already in progress');
  eq((await getWebCacheStats()).entries,0,'no in-memory cached entry resurrects after clear');
});

// —— 13. 缓存命中启动：不等待网络、零请求（#18「start from a valid cached entry」） ——
await section('cache-hit startup never touches network', async () => {
  fakeStorageReset();
  goodFetch();
  eq(await (await prepareWebAudio(KEY1)).done, true, 'seed complete entry');
  await getWebCacheStats(); // 索引已暖：命中判定同步可见
  __resetWebAudioCacheStateForTest(); // 模拟页面重载（CacheStorage 保留）
  await getWebCacheStats(); // 重载后预热索引（播放器挂载时 primeWebAudioCacheIndex 做同一件事）
  class Media extends EventTarget {
    src = ''; currentTime = 0; playbackRate = 1; volume = 1; muted = false; paused = true; error = null; plays = 0;
    getAttribute() { return this.src; }
    load() { this.currentTime = 0; queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    pause() { this.paused = true; }
    play() { this.plays++; return Promise.resolve(); }
  }
  let network = 0;
  globalThis.fetch = async () => { network++; throw TypeError('network must not be used'); };
  const m = new Media();
  attachAudioRenewal(m, () => 'entry', (msg) => { throw Error('unexpected failure: ' + msg); });
  m.src = KEY1; m.load();
  await m.play();
  eq(network, 0, 'sync-known cache hit starts no resolve/download request at all');
  ok(m.src.startsWith('blob:'), 'playback starts from the cached blob immediately');
  eq(m.plays, 1, 'play proceeded without waiting for network');
});

// —— 14. 失败/部分响应绝不替换完整条目（#18「failed/partial refresh」） ——
await section('failed or partial refresh never replaces a complete entry', async () => {
  fakeStorageReset();
  goodFetch();
  eq(await (await prepareWebAudio(KEY1)).done, true, 'complete entry seed');
  const before = await getWebCacheStats();
  // 206 / 失败响应即使被请求也绝不入缓存；命中路径根本不发请求。
  globalThis.fetch = async () => new Response(AUDIO_BODY.slice(0, 100), { status: 206, headers: { 'content-type': 'audio/ogg', 'content-range': 'bytes 0-99/9999' } });
  const hit = await prepareWebAudio(KEY1);
  ok(hit.cached && hit.url.startsWith('blob:'), 'existing complete entry still serves');
  hit.release();
  globalThis.fetch = async () => { throw TypeError('offline'); };
  const still = await prepareWebAudio(KEY1);
  ok(still.cached, 'network failure cannot demote a complete entry');
  still.release();
  const after = await getWebCacheStats();
  eq([after.entries, after.bytes], [before.entries, before.bytes], 'complete entry bytes/entries unchanged');
  // 解绑定后的播放（renew 强制）在断网下也不能丢条目。
  class Media extends EventTarget {
    src = ''; currentTime = 0; playbackRate = 1; volume = 1; muted = false; paused = true; error = null; plays = 0;
    getAttribute() { return this.src; } load() { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); } pause() { this.paused = true; } play() { this.plays++; return Promise.resolve(); }
  }
  const errors = [];
  const m = new Media();
  const handle = attachAudioRenewal(m, () => 'entry', (msg) => errors.push(msg));
  m.src = KEY1; m.load();
  await m.play();
  await handle.renew(true);
  ok(m.src.startsWith('blob:'), 'forced renew still plays from the complete cache entry offline');
  eq(await getWebAudioEntryState(KEY1), 'cached', 'entry survived forced renew while offline');
  eq(errors, [], 'no spurious failure surfaced');
});

// —— 15. 慢读期间被失效/清除：旧字节不覆盖新状态（#18「obsolete response」） ——
await section('stale read cannot overwrite invalidation or clear', async () => {
  fakeStorageReset();
  goodFetch();
  eq(await (await prepareWebAudio(KEY1)).done, true, 'seed');
  const cache = await globalThis.caches.open(WEB_AUDIO_CACHE_NAME);
  // (a) 读挂在 match 上，期间条目被 invalidate：旧字节不得复活内存条目
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  cache.matchGate = gate;
  const slow = acquireCachedAudio(KEY1);
  await sleep(5);
  await invalidateCachedAudio(KEY1);
  releaseGate();
  cache.matchGate = null;
  eq(await slow, null, 'stale read returns null instead of resurrecting an invalidated entry');
  eq(await getWebAudioEntryState(KEY1), 'none', 'invalidated entry stays gone');
  eq((await getWebCacheStats()).entries, 0, 'no phantom size entry after invalidation');
  // (b) 慢读期间 clear：同样不复活
  goodFetch();
  eq(await (await prepareWebAudio(KEY2)).done, true, 'seed key2');
  let releaseGate2;
  const gate2 = new Promise((r) => { releaseGate2 = r; });
  cache.matchGate = gate2;
  const slow2 = acquireCachedAudio(KEY2);
  await sleep(5);
  await clearWebAudioCache();
  releaseGate2();
  cache.matchGate = null;
  eq(await slow2, null, 'stale read after clear returns null');
  eq((await getWebCacheStats()).entries, 0, 'clear stays clear (no late entry)');
});

// —— 16. 成功替换：只有完整体才能顶替旧条目（#18「successful replacement」） ——
await section('successful replacement after invalidation', async () => {
  fakeStorageReset();
  goodFetch();
  eq(await (await prepareWebAudio(KEY1)).done, true, 'old entry seed');
  const oldBytes = (await getWebCacheStats()).bytes;
  await invalidateCachedAudio(KEY1);
  const NEW_BODY = 'NEWOGG'.repeat(3000);
  globalThis.fetch = async () => new Response(NEW_BODY, { status: 200, headers: { 'content-type': 'audio/ogg' } });
  const fresh = await prepareWebAudio(KEY1);
  eq(await fresh.done, true, 'replacement downloaded');
  const stats = await getWebCacheStats();
  eq(stats.entries, 1, 'still one entry');
  ok(stats.bytes === new TextEncoder().encode(NEW_BODY).byteLength && stats.bytes !== oldBytes, 'new complete bytes replaced the old size');
  const replay = await prepareWebAudio(KEY1);
  ok(replay.cached && replay.url.startsWith('blob:'), 'replacement is what plays next');
  replay.release();
});

console.log(`web offline cache: ${checks} checks passed`);
