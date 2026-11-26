// 目录离线冷启动回归测试：vite-node 编译驱动真实 backend.svelte.ts + catalog-offline.ts。
// 覆盖：在线提交后持久化（先不可变文档后指针）、离线冷启动恢复（含歌词全字段）、无缓存明确、
// 损坏快照不 hydrate、后端 origin 隔离、网络/恢复先后与切 base 所有权、quota 与 too-large 不阻塞、
// 3 月 LRU 上限、非 TypeError 不供给、abort 直通、304 保留快照状态、默认存储选型（CacheStorage/localStorage）。
// 运行：npx vite-node scripts/test-catalog-offline.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { monthBounds } from '../src/lib/month.js';

let nativeMode = false;
let bridgeHandler = async () => null;
const store = new Map(); // 模拟 localStorage 持久层
const ls = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => store.delete(k),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window = { localStorage: ls, location: { origin: 'https://app.local', href: 'https://app.local/', reload() {} }, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: 'visible' };
globalThis.localStorage = ls;

const { ViteNodeRunner } = await import('vite-node/client');
const cachedAudioUrls = new Set(); // 模拟网页音频缓存里已有的完整条目（#18/#19 裁定 ④）
const original = ViteNodeRunner.prototype.dependencyRequest;
ViteNodeRunner.prototype.dependencyRequest = function (id, fsPath, callstack) {
  const sid = String(id), sp = String(fsPath);
  if (sid === '$env/dynamic/public' || sp.includes('env/dynamic/public')) return Promise.resolve({ env: {} });
  if (sid === '@capacitor/core' || sp.includes('@capacitor/core')) return Promise.resolve({
    Capacitor: { isNativePlatform: () => nativeMode, getPlatform: () => (nativeMode ? 'ios' : 'web') },
    registerPlugin: () => null,
  });
  if (sp.endsWith('/native-cache.ts')) return Promise.resolve({
    nativeFetchJSON: (url, options = {}) => bridgeHandler(url, options),
    nativeAudioSrc: u => u,
    nativeCacheAvailable: () => false,
  });
  if (sp.endsWith('/native-audio.ts')) return Promise.resolve({
    NativeAudio: class { constructor() { this.ready = Promise.resolve(); } refresh() { return Promise.resolve(); } sync() { return Promise.resolve(); } },
    usesNativeAudio: () => false,
  });
  if (sp.endsWith('/web-audio-cache.ts')) return Promise.resolve({
    hasCachedAudioSync: url => cachedAudioUrls.has(String(url)),
    primeWebAudioCacheIndex: () => {},
  });
  return original.call(this, id, fsPath, callstack);
};

const rec = await import('../src/lib/catalog-recovery');
const O = await import('../src/lib/catalog-offline');
rec.configureCatalogTimeouts({ requestMs: 150, operationMs: 8000, nativeBridgeMs: 30, coalesceMs: 20 });

// —— 测试装置 ——
let routes = [], fetchLog = [];
const on = (sub, handler) => routes.push({ sub, handler });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const abortErr = () => new DOMException('Aborted', 'AbortError');
const pointerRes = (etag = 'PE') => ({ ok: true, status: 200, headers: { get: k => (String(k).toLowerCase() === 'etag' ? etag : null) }, json: async () => ({ schemaVersion: 2, releaseId: 'a'.repeat(64) }) });
const jsonRes = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const netFail = () => new TypeError('fetch failed'); // 真实网络栈失败形态
const audioIn = (audioId, monthId, withLyrics = true) => {
  const b = monthBounds(monthId);
  return { id: audioId, file: audioId + '.wav', opus: audioId + '.opus', title: audioId, startAt: b.startAt + 86400 * 2, duration: 100, lyrics: withLyrics ? [{ t: 1, text: '一行歌词' }] : [], monthId };
};
const MONTH_IDS = ['2023-11', '2023-12', '2024-01', '2024-02'];
const catalogFixture = (revision, ids = MONTH_IDS, counts = {}) => ({
  schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: 1700000000, revision,
  months: ids.map(id => { const b = monthBounds(id); return { id, startAt: b.startAt, endAt: b.endAt, count: counts[id] ?? 1, revision: 'm-' + id + '-' + revision, key: id + '.json', available: true }; }),
});
const monthFixture = (id, revision, n = 1) => ({ schemaVersion: 2, id, revision: 'm-' + id + '-' + revision, audios: Array.from({ length: n }, (_, i) => audioIn(`${id}-${i + 1}`, id)) });
function onlineFetch(custom) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    fetchLog.push({ url: u, opts });
    if (custom) { const early = custom(u, opts); if (early !== undefined) return early; }
    const hit = routes.find(r => u.includes(String(r.sub)));
    if (!hit) throw new Error('no fetch route for ' + u); // 业务级 Error：绝不能触发离线供给
    return hit.handler(u, opts);
  };
}
function offlineFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    fetchLog.push({ url: String(url), opts });
    const s = opts?.signal;
    if (s?.aborted) throw abortErr();
    await sleep(2);
    if (s?.aborted) throw abortErr();
    throw netFail();
  };
}
const withSlowKv = (inner, ms) => ({
  kind: () => 'memory',
  budgetBytes: () => inner.budgetBytes(),
  get: async k => { await sleep(ms); return inner.get(k); },
  set: (k, v) => inner.set(k, v),
  delete: k => inner.delete(k),
  keys: p => inner.keys(p),
});
let kv = null;
function freshKv(options = {}) { kv = O.createMemoryKv(options); O.configureOfflineKv(kv); return kv; }
const monthDocKeys = () => kv.keys('aof|M|');
async function flush() { await O.flushOfflineWrites(); }
async function waitIdle(B) { for (let i = 0; i < 400; i++) { if (!B.backend.pending) return; await sleep(5); } throw Error('pending never cleared'); }
let bootSeq = 0;
const BACKEND_ABS = new URL('../src/lib/backend.svelte.ts', import.meta.url).pathname;
async function boot() { bootSeq++; return await import(BACKEND_ABS + '?boot=' + bootSeq); } // 全新 backend 模块实例 = 模拟进程重启；kv/supply 工厂等共享模块维持持久语义
let checks = 0;
const step = (cond, msg) => { assert.ok(cond, msg); checks++; };

// ============ S0：catalog-offline 单元（键隔离、防御、空态） ============
{
  freshKv();
  step(O.offlineBaseKey('') === 'same-origin', 'empty base maps to same-origin');
  step(O.offlineBaseKey('https://a.test:3000/x?y=1') === 'https://a.test:3000/x', 'base key includes backend path');
  step(!O.offlineBaseKey('not a url|weird').includes('|'), 'unparsable base key never injects separator');
  step((await O.saveManifestSnapshot('', { schemaVersion: 1 }, {})).status === 'invalid', 'unvalidated manifest is not persisted');
  step((await O.saveMonthSnapshot('', null, '2024-01', [])).status === 'stale', 'month save without manifest/pointer is stale-skipped');
  step((await O.loadOfflineSnapshot('')).status === 'empty', 'empty storage is explicit empty');
  step(await O.serveOfflineJson('', '/api/search?q=x') === null, 'search is never offline-served');
  step(O.offlineStorageInfo().kind === 'memory' && O.offlineStorageInfo().maxMonths === 3, 'injected kv + default month cap');
  const ac = new AbortController(); ac.abort();
  step(await O.serveOfflineJson('', '/api/catalog', ac.signal) === null, 'aborted serve is refused');
}

// ============ S1：在线提交 → 持久化（先文档后指针、歌词全字段、3 月 LRU） ============
{
  freshKv(); onlineFetch(); nativeMode = false;
  routes = [];
  const B = await boot();
  B.resetCatalog();
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-1')));
  for (const id of MONTH_IDS) on('/api/month/' + id, () => jsonRes(monthFixture(id, 'rev-1')));
  await B.fetchIndex();
  await B.loadMonth('2023-11'); await flush();
  await B.loadMonth('2023-12'); await flush();
  await B.loadMonth('2024-01'); await flush();
  await B.loadMonth('2024-02'); await flush();
  step(B.backend.manifest?.revision === 'rev-1', 'online commit rev-1');
  step(Object.keys(B.backend.months).length === 3, 'memory trim keeps MAX_CACHED_MONTHS=3');
  step(!B.backend.months['2023-11'], 'oldest month trimmed from memory');
  step(typeof B.backend.offlineSavedAt === 'number' && B.backend.offlineSavedAt > 0, 'offlineSavedAt advanced on save');
  step(B.backend.offline === false && B.backend.offlineNotice === '', 'fresh network state is not flagged offline');
  const pointer = JSON.parse(await kv.get('aof|p|same-origin'));
  step(pointer.revision === 'rev-1', 'pointer advanced to committed revision');
  step(Object.keys(pointer.months).length === 3 && !pointer.months['2023-11'], 'snapshot holds bounded 3-month LRU (no unbounded save)');
  step((await monthDocKeys()).length === 3, 'exactly 3 immutable month docs on disk');
  const stored = JSON.parse(await kv.get('aof|M|same-origin|rev-1|2024-01'));
  step(stored.revision === 'm-2024-01-rev-1' && stored.audios[0].lyrics.length === 1, 'month doc keeps all fields incl. lyrics, matching revision');
  step(JSON.parse(await kv.get('aof|M|same-origin|rev-1|2023-12')).id === '2023-12', 'memory-trimmed valid month stays persisted (trim never deletes snapshot)');
}

// ============ S2：离线冷启动（全新模块实例=进程重启；快照供给浏览/队列解析） ============
{
  offlineFetch(); nativeMode = false;
  const B2 = await boot();
  const restored = await (B2.initBackend(), B2.hydrateOfflineCatalog());
  await waitIdle(B2);
  step(restored === true, 'offline cold start hydrates snapshot');
  step(B2.backend.manifest?.revision === 'rev-1', 'hydrated manifest without any network');
  step(B2.backend.offline === true, 'offline flag set for UI');
  step(B2.backend.months['2024-01']?.[0].lyrics.length === 1, 'hydrated month keeps lyrics');
  step(!B2.backend.months['2023-11'] && Object.keys(B2.backend.months).length === 3, 'hydration bounded to saved 3 months');
  step(B2.backend.error !== '', 'unreachable /api/current surfaces an error (not pretending fresh)');
  step(typeof B2.backend.offlineSavedAt === 'number', 'offlineSavedAt exposed for hints');
  const before = fetchLog.filter(e => e.url.includes('/api/month/')).length;
  step((await B2.loadMonth('2024-02')).length === 1, 'hydrated month loads from memory');
  step(fetchLog.filter(e => e.url.includes('/api/month/')).length === before, 'cached month load costs zero network');
  await assert.rejects(B2.loadMonth('2023-11'), 'evicted month fails honestly');
  step(!!B2.backend.errors['2023-11'], 'evicted month error is explicit');
  step(B2.backend.offline === true, 'failed month does not fake freshness');
  const inRange = await B2.audiosInRange(monthBounds('2024-01').startAt, monthBounds('2024-03').startAt);
  step(inRange.length === 2, 'range browse works offline via snapshot month serving');
  const one = await B2.resolveAudio('2024-02-1', '2024-02');
  step(one?.id === '2024-02-1', 'queue-style resolve works offline');
  const served = await O.serveOfflineJson('', '/api/month/2024-01?release=rev-1');
  step(served?.headers.get('x-anyun-cache') === 'offline', 'served response is marked offline');
  step(await O.serveOfflineJson('', '/api/month/2024-01?release=rev-wrong') === null, 'serve refuses release mismatch');
  // 304（连接恢复、版本未变）：错误清、快照状态保留
  const keepMonths = B2.backend.months;
  routes = [];
  onlineFetch(u => u.includes('/api/current') ? Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, json: async () => { throw Error('304 body'); } }) : undefined);
  await B2.fetchIndex();
  step(B2.backend.error === '', '304 clears the offline update error');
  step(B2.backend.months === keepMonths && B2.backend.offline === false, '304 confirms current catalog while retaining snapshot months');
  offlineFetch();
}

// ============ S3：无缓存：明确空状态、不假装新鲜 ============
{
  freshKv(); offlineFetch();
  const B3 = await boot();
  const restored = await (B3.initBackend(), B3.hydrateOfflineCatalog());
  await waitIdle(B3);
  step(restored === false && B3.backend.manifest === null, 'no snapshot -> no content (explicit)');
  step(B3.backend.offline === false && B3.backend.offlineNotice === '', 'no snapshot leaves no offline mark');
  step(B3.backend.error !== '', 'offline failure is visible');
  await assert.rejects(B3.loadMonth('2024-01'), e => /尚未发布|超出/.test(e.message), 'month request says out-of-range, not fake data');
}

// ============ S4：损坏快照不 hydrate、清理、联网重建 ============
{
  freshKv(); onlineFetch();
  const B4 = await boot();
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-4')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01', 'rev-4')));
  await B4.fetchIndex(); await B4.loadMonth('2024-01'); await flush();
  await kv.set((await kv.keys('aof|m|'))[0], '{definitely-not-json'); // 注入损坏
  const B5 = await boot();
  offlineFetch();
  const restored = await (B5.initBackend(), B5.hydrateOfflineCatalog());
  await waitIdle(B5);
  step(restored === false, 'corrupt manifest never hydrates');
  step(B5.backend.manifest === null && B5.backend.offline === false, 'corrupt snapshot yields honest empty state');
  step(/损坏/.test(B5.backend.offlineNotice), 'corruption is distinguished from absence: ' + B5.backend.offlineNotice);
  step(await kv.get('aof|p|same-origin') === null, 'corrupt snapshot records were pruned');
  onlineFetch();
  await B5.fetchIndex(); await flush();
  step(B5.backend.manifest?.revision === 'rev-4' && JSON.parse(await kv.get('aof|m|same-origin|rev-4')).revision === 'rev-4', 'network rebuilds snapshot after corruption');
}

// ============ S5：后端 origin 隔离；reset/切后端不删快照，clear 只删用户所选范围 ============
{
  freshKv(); onlineFetch(); nativeMode = true;
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-A')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01', 'rev-A')));
  const B6 = await boot();
  B6.saveBackendBase('https://alpha.test');
  await waitIdle(B6);
  await B6.loadMonth('2024-01'); await flush();
  step(await kv.get('aof|p|https://alpha.test') !== null, 'alpha pointer persisted');
  step(typeof B6.backend.offlineSavedAt === 'number', 'alpha save advanced offlineSavedAt');
  const B7 = await boot();
  offlineFetch(); // beta 完全不可达
  B7.saveBackendBase('https://beta.test');
  const betaRestored = await B7.hydrateOfflineCatalog();
  await waitIdle(B7);
  step(betaRestored === false && B7.backend.manifest === null && B7.backend.offline === false, 'beta never hydrates alpha content');
  step(Object.keys(B7.backend.months).length === 0 && !B7.backend.manifest, 'no cross-backend month leak');
  step(await B7.clearOfflineCatalog('current') === 0 && (await kv.get('aof|p|https://alpha.test')) !== null, 'clearing beta scope never deletes alpha snapshot');
  step(await B7.clearOfflineCatalog('all') === 3 && (await kv.get('aof|p|https://alpha.test')) === null, 'explicit all-clear removes exactly the stored snapshot records');
  routes = routes.filter(r => r.sub !== '/api/catalog');
  on('/api/catalog', () => jsonRes(catalogFixture('rev-A2')));
  onlineFetch();
  B7.saveBackendBase('https://alpha.test'); // 回到 alpha 并重建快照
  await waitIdle(B7); await flush();
  step(JSON.parse(await kv.get('aof|p|https://alpha.test')).revision === 'rev-A2', 'alpha snapshot rebuilt under its own origin key');
  B7.resetCatalog();
  step(await kv.get('aof|p|https://alpha.test') !== null, 'resetCatalog never deletes the persisted snapshot (memory-only reset)');
  nativeMode = false;
}

// ============ S6：网络先完成 vs 快照先恢复（所有权两向） ============
{
  // (a) 网络先：慢存储的 hydrate 不得覆盖已提交的网络结果
  freshKv(); onlineFetch();
  const B8 = await boot();
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-9')));
  await B8.fetchIndex(); await flush();
  O.configureOfflineKv(withSlowKv(kv, 40));
  const B9 = await boot();
  routes = routes.filter(r => r.sub !== '/api/catalog');
  on('/api/catalog', () => jsonRes(catalogFixture('rev-10')));
  const hydrateResult = await (B9.initBackend(), B9.hydrateOfflineCatalog());
  await waitIdle(B9); await flush();
  step(hydrateResult === false, 'hydrate loses the race and stands down');
  step(B9.backend.manifest?.revision === 'rev-10' && B9.backend.offline === false, 'network commit is never overwritten by restore');
  // (b) 快照先：离线 hydrate 立即可浏览；网络随后完成时正常升级
  O.configureOfflineKv(kv);
  const B10 = await boot();
  rec.configureCatalogTimeouts({ requestMs: 2000 }); // 本场景考察并发而非超时
  const d = deferred();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    fetchLog.push({ url: u, opts });
    if (u.includes('/api/current')) return d.promise;
    if (u.includes('/api/catalog')) return jsonRes(catalogFixture('rev-10b'));
    throw netFail();
  };
  const restored = await (B10.initBackend(), B10.hydrateOfflineCatalog());
  step(restored === true && B10.backend.manifest?.revision === 'rev-10' && B10.backend.offline === true, 'snapshot hydrates while pointer still hangs');
  d.resolve(pointerRes());
  await waitIdle(B10);
  step(B10.backend.manifest?.revision === 'rev-10b' && B10.backend.offline === false, 'late network result upgrades the restored snapshot');
  rec.configureCatalogTimeouts({ requestMs: 150 });
}

// ============ S7：恢复途中切后端：旧所有权作废、不串数据 ============
{
  await O.saveManifestSnapshot('https://alpha.test', catalogFixture('rev-ALPHA')); // 用真 kv 先落 alpha 快照
  O.configureOfflineKv(withSlowKv(kv, 40));
  const B11 = await boot();
  nativeMode = true;
  B11.backend.base = 'https://alpha.test';
  const hp = B11.hydrateOfflineCatalog(); // alpha 读取卡在读延迟里
  offlineFetch();
  B11.saveBackendBase('https://gamma.test'); // generation+base 同换
  step(await hp === false, 'pending hydrate is voided after backend switch');
  const later = await B11.hydrateOfflineCatalog();
  await waitIdle(B11);
  step(later === false && B11.backend.manifest === null && B11.backend.offline === false, 'gamma never inherits alpha snapshots');
  step(Object.keys(B11.backend.months).length === 0 && B11.backend.error !== '', 'gamma state honest: no months, visible failure');
  nativeMode = false;
  O.configureOfflineKv(kv);
}

// ============ S8：quota 与 too-large：浏览不受阻、状态可提示、可恢复 ============
{
  freshKv({ budgetBytes: 60000 }); onlineFetch();
  const B12 = await boot();
  routes = [];
  const ids = ['2024-01', '2024-02', '2024-03', '2024-04'];
  const counts = { '2024-01': 250, '2024-02': 250, '2024-03': 1600, '2024-04': 250 };
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-Q', ids, counts)));
  for (const id of ids) on('/api/month/' + id, () => jsonRes(monthFixture(id, 'rev-Q', counts[id])));
  await B12.fetchIndex(); await flush();
  step(B12.backend.manifest?.revision === 'rev-Q', 'manifest+pointer survive small budget');
  const a1 = await B12.loadMonth('2024-01'); await flush();
  step(a1.length === 250 && (await monthDocKeys()).length === 1, 'first big month persisted under budget');
  const a2 = await B12.loadMonth('2024-02'); await flush();
  step(a2.length === 250, 'quota failure never blocks month loading');
  step(/存储空间不足/.test(B12.backend.offlineNotice), 'quota is surfaced: ' + B12.backend.offlineNotice);
  step((await monthDocKeys()).length === 1, 'over-budget month doc never written');
  const a3 = await B12.loadMonth('2024-03'); await flush();
  step(a3.length === 1600, 'oversized month still loads for browsing');
  step(/目录过大/.test(B12.backend.offlineNotice), 'too-large guard (skips giant stringify) is surfaced');
  kv.setBudget(400000);
  const a4 = await B12.loadMonth('2024-04'); await flush();
  step(a4.length === 250 && B12.backend.offlineNotice === '', 'recovered budget clears the notice on next save');
  step((await kv.keys('aof|M|')).length <= 3, 'month docs stay bounded under LRU cap');
}

// ============ S9：供给只认网络层 TypeError；abort 直通 ============
{
  freshKv(); onlineFetch();
  const B13 = await boot();
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-1')));
  for (const id of MONTH_IDS) on('/api/month/' + id, () => jsonRes(monthFixture(id, 'rev-1')));
  await B13.fetchIndex(); await B13.loadMonth('2024-01'); await flush();
  // 非网络层错误：绝不静默供给旧数据（保护 94 项旧回归的语义边界）
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/api/current')) return pointerRes();
    if (u.includes('/api/catalog')) return jsonRes(catalogFixture('rev-1'));
    throw new Error('boom-business'); // 不是 TypeError
  };
  await assert.rejects(B13.loadMonth('2023-11'), e => /boom-business/.test(e.message), 'business errors are never masked by snapshot');
  // abort：离线供给拒绝已中止的信号
  offlineFetch();
  const c = new AbortController();
  const p = B13.loadMonth('2023-12', c.signal).catch(e => e);
  c.abort();
  const err = await p;
  step(err?.name === 'AbortError', 'aborted month load stays aborted despite available snapshot');
  step(B13.backend.errors['2023-12'] === undefined, 'abort does not poison month errors');
}

// ============ S10：写失败旧快照完好（先文档后指针的原子性） ============
{
  freshKv(); onlineFetch();
  const B14 = await boot();
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-A')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01', 'rev-A')));
  await B14.fetchIndex(); await B14.loadMonth('2024-01'); await flush();
  const oldMonthKey = 'aof|M|same-origin|rev-A|2024-01';
  step(await kv.get(oldMonthKey) !== null, 'baseline snapshot rev-A stored');
  kv.failNextWith('quota'); // 下一次 set = rev-B 的 manifest 文档写入
  routes = routes.filter(r => !String(r.sub).includes('/api/catalog') && !String(r.sub).includes('/api/month/'));
  on('/api/catalog', () => jsonRes(catalogFixture('rev-B')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01', 'rev-B')));
  await B14.fetchIndex(); await flush();
  step(B14.backend.manifest?.revision === 'rev-B', 'memory advances on network success');
  step(JSON.parse(await kv.get('aof|p|same-origin')).revision === 'rev-A', 'failed doc write never advances the pointer');
  step(await kv.get(oldMonthKey) !== null, 'old snapshot stays fully intact');
  step(/存储空间不足/.test(B14.backend.offlineNotice), 'save failure is hinted');
  await B14.fetchIndex(); await flush(); // 恢复后重试验证推进
  step(JSON.parse(await kv.get('aof|p|same-origin')).revision === 'rev-B', 'pointer advances only after complete write');
  step((await kv.keys('aof|m|same-origin|rev-A')).length === 0 && (await kv.keys('aof|M|same-origin|rev-A')).length === 0, 'superseded revision docs are pruned');
}

// ============ S11：指针 200 但目录 JSON 只能离线供给：不算刷新成功、不存 etag ============
{
  // 复用 S10 末态：kv 里 pointer=rev-B（same-origin）
  const B16 = await boot();
  onlineFetch((u, opts) => { if (u.includes('/api/catalog') || u.includes('/api/month/')) throw netFail(); });
  routes = [];
  on('/api/current', () => pointerRes('E-NEW'));
  const restored = await (B16.initBackend(), B16.hydrateOfflineCatalog());
  await waitIdle(B16);
  step(restored === true && B16.backend.offline === true, 'snapshot hydrates offline state');
  await B16.fetchIndex();
  step(/显示最后保存的目录/.test(B16.backend.error), 'offline-served catalog is reported as not-a-refresh: ' + B16.backend.error);
  step(B16.backend.manifest?.revision === 'rev-B' && B16.backend.offline === true, 'stale serve does not fake freshness nor advance state');
  let etagSeen;
  onlineFetch((u, opts) => { if (u.includes('/api/current')) etagSeen = opts?.headers?.['If-None-Match']; });
  routes = [];
  on('/api/current', () => pointerRes('E2'));
  on('/api/catalog', () => jsonRes(catalogFixture('rev-C')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01', 'rev-C'))); // 已持有月块要升级到新 revision：网络全通才能提交
  await B16.fetchIndex(); await flush();
  step(etagSeen === undefined, 'stale serve never banked the new etag (next check revalidates honestly)');
  step(B16.backend.manifest?.revision === 'rev-C' && B16.backend.offline === false, 'full network recovery completes the refresh');
}

// ============ S12：损坏/篡改的月块经供给路径也被 schema 复验拒绝 ============
{
  // 承接 S11：kv pointer=rev-C（months 元数据空）；B17 在线重建内存状态后补存合法月块再篡改
  const B17 = await boot();
  onlineFetch();
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-C')));
  await B17.fetchIndex(); await flush();
  step(B17.backend.manifest?.revision === 'rev-C', 'online boot commits the last good revision');
  const saveResult = await O.saveMonthSnapshot('', B17.backend.manifest, '2024-01', monthFixture('2024-01', 'rev-C').audios);
  await flush();
  step(saveResult.ok === true, 'valid month snapshot written through the real save path');
  const validDoc = JSON.parse(await kv.get('aof|M|same-origin|rev-C|2024-01'));
  step(validDoc.audios.length === 1 && validDoc.revision === 'm-2024-01-rev-C', 'month doc matches manifest entry revision');
  await kv.set('aof|M|same-origin|rev-C|2024-01', JSON.stringify({ schemaVersion: 2, id: '2024-01', revision: 'tampered', audios: [] }));
  const B18 = await boot();
  onlineFetch((u, opts) => { if (u.includes('/api/month/')) throw netFail(); });
  routes = [];
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-C')));
  await B18.fetchIndex();
  await assert.rejects(B18.loadMonth('2024-01'), /Invalid month/, 'tampered month doc rejected by schema revalidation');
  step(!!B18.backend.errors['2024-01'], 'served-corruption surfaces as month error, not silent bad data');
  step(B18.backend.offline === false, 'month failure does not fake an offline-committed state');
}

// ============ S13：默认存储选型（web CacheStorage 优先 / Capacitor 与回退 localStorage / 全无静默） ============
{
  O.configureOfflineKv(null);
  delete globalThis.caches;
  step(O.offlineStorageInfo({ native: false }).kind === 'localstorage', 'web without CacheStorage falls back to localStorage');
  step(O.offlineStorageInfo({ native: true }).kind === 'localstorage', 'Capacitor prefers localStorage (bounded JSON pieces)');
  const fake = (() => {
    const data = new Map();
    const cache = {
      async match(r) { const hit = data.get(String(r)); return hit === undefined ? undefined : new Response(hit, { headers: { 'content-type': 'application/json' } }); },
      async put(req, res) { data.set(String(req.url), await res.text()); },
      async delete(r) { return data.delete(String(r)); },
      async keys() { return [...data.keys()].map(url => ({ url })); },
    };
    return { data, caches: { open: async () => cache } };
  })();
  globalThis.caches = fake.caches;
  step(O.offlineStorageInfo({ native: false }).kind === 'cachestorage', 'web uses CacheStorage when available');
  step(O.offlineStorageInfo({ native: true }).kind === 'localstorage', 'Capacitor still bypasses a present-but-unreliable CacheStorage');
  const saved = await O.saveManifestSnapshot('', catalogFixture('rev-CS'));
  step(saved.ok === true && [...fake.data.keys()].some(k => k.includes('aof%7Cp%7C')), 'CacheStorageKv stores the pointer as a cache entry');
  const loaded = await O.loadOfflineSnapshot('');
  step(loaded.status === 'snapshot' && loaded.manifest.revision === 'rev-CS', 'CacheStorageKv round-trips the snapshot');
  delete globalThis.caches;
  const savedLS = await O.saveManifestSnapshot('', catalogFixture('rev-LS'));
  step(savedLS.ok === true && store.get('aof|p|same-origin') !== undefined, 'localStorage fallback actually persisted through the shim');
  const lsBytes = [...store.keys()].filter(k => k.startsWith('aof|')).reduce((n, k) => n + (store.get(k)?.length ?? 0), 0);
  step(lsBytes <= O.offlineStorageInfo({ native: false }).budgetBytes, 'localStorage snapshot respects its explicit budget');
  const loadedLS = await O.loadOfflineSnapshot('');
  step(loadedLS.status === 'snapshot' && loadedLS.manifest.revision === 'rev-LS', 'localStorage round-trips too');
}

// ============ S14：无任何存储后端：全部操作静默降级、不炸 ============
{
  delete globalThis.localStorage;
  const prevWindowLS = globalThis.window.localStorage;
  globalThis.window.localStorage = undefined;
  delete globalThis.caches;
  step(O.offlineStorageInfo({ native: false }).kind === 'none', 'no storage backend is detectable as none');
  step((await O.saveManifestSnapshot('', catalogFixture('rev-X'))).status === 'no-storage', 'saves degrade without storage');
  step((await O.loadOfflineSnapshot('')).status === 'empty', 'load sees empty without storage');
  step((await O.clearOfflineSnapshots('')) === 0, 'clear is a no-op without storage');
  globalThis.window.localStorage = prevWindowLS;
  globalThis.localStorage = ls;
}

// Full snapshot transactions never expose new revision without its complete loaded months.
{
  freshKv();
  const old = catalogFixture('atomic-old');
  const next = catalogFixture('atomic-next');
  const id = '2024-01';
  step((await O.saveCatalogSnapshot('', old, {[id]:monthFixture(id,'atomic-old').audios})).ok, 'atomic old revision saved');
  await O.saveManifestSnapshot('', old);
  step(Object.keys((await O.loadOfflineSnapshot('')).months).length === 1, 'same revision poll never discards saved months');
  const originalKv = kv;
  let writeCount = 0;
  O.configureOfflineKv({kind:()=> 'fault', budgetBytes:()=>Infinity, get:k=>originalKv.get(k), delete:k=>originalKv.delete(k), keys:p=>originalKv.keys(p), set:async(k,v)=>{if(++writeCount===3)throw Error('pointer failure');await originalKv.set(k,v);}});
  const failed = await O.saveCatalogSnapshot('', next, {[id]:monthFixture(id,'atomic-next').audios});
  step(!failed.ok, 'pointer failure is reported');
  let snapshot = await O.loadOfflineSnapshot('');
  step(snapshot.manifest.revision === 'atomic-old' && snapshot.months[id].audios.length === 1, 'pointer failure preserves full old revision');
  step((await kv.keys('aof|')).length === 3, 'failed staging cleaned up without orphans');
  O.configureOfflineKv(originalKv);
  step((await O.saveCatalogSnapshot('', next, {[id]:monthFixture(id,'atomic-next').audios})).ok, 'new full revision commits');
  snapshot = await O.loadOfflineSnapshot('');
  step(snapshot.manifest.revision === 'atomic-next' && snapshot.months[id].revision === 'm-'+id+'-atomic-next', 'new pointer contains complete matching month');
  await O.saveCatalogSnapshot('https://fixture.example/one',old,{});
  step((await O.loadOfflineSnapshot('https://fixture.example/two')).status === 'empty', 'different backend paths never share snapshots');
}

{
  freshKv();const m=catalogFixture('queued-save');
  const initial=O.saveManifestSnapshot('',m);
  const month=O.saveMonthSnapshot('',m,'2024-01',monthFixture('2024-01','queued-save').audios);
  await initial;
  step((await month).ok, 'month queued during manifest persistence waits for committed pointer');
  step(!!(await O.loadOfflineSnapshot('')).months['2024-01'], 'concurrent initial snapshot retains loaded month');
}

{
  freshKv();nativeMode=false;onlineFetch();routes=[];
  const waiting=deferred(),started=deferred();
  on('/api/current',()=>pointerRes());
  on('/api/catalog',()=>{started.resolve();return waiting.promise;});
  const B=await boot();const task=B.fetchIndex();await started.promise;
  await B.clearOfflineCatalog('all');
  waiting.resolve(jsonRes(catalogFixture('after-clear')));await task;await flush();
  step(B.backend.manifest?.revision==='after-clear','in-flight response may finish current browsing after clear');
  step((await O.loadOfflineSnapshot('')).status==='empty','pre-clear catalog fetch cannot repopulate persistent snapshot');
}

// ============ S15：重验证节奏（#19）：可变的目录 JSON 远比不可变音频勤快 ============
{
  const root = path.resolve(import.meta.dirname, '..');
  const page = fs.readFileSync(path.join(root, 'src/routes/+page.svelte'), 'utf8');
  const backendSrc = fs.readFileSync(path.join(root, 'src/lib/backend.svelte.ts'), 'utf8');
  const audioSrc = fs.readFileSync(path.join(root, 'src/lib/web-audio-cache.ts'), 'utf8');
  // 网页目录：30s 心跳 + 回前台/pageshow/online + 手动刷新，全部走 fetchIndex（/api/current，no-store + ETag）
  step(/setInterval\(refresh,30000\)/.test(page), 'web catalog has a 30s background revalidation cadence');
  step(page.includes("addEventListener('visibilitychange',onLifecycle)") && page.includes("addEventListener('pageshow',onLifecycle)"), 'web catalog revalidates on visibility/pageshow');
  step(page.includes('recoverCatalog();'), 'lifecycle events go through the coalesced recovery entry');
  step(fs.readFileSync(path.join(root, 'src/lib/components/RefreshMenu.svelte'), 'utf8').includes('recoverCatalog({ force: true })'), 'manual refresh forces a catalog revalidation');
  step(backendSrc.includes("window.addEventListener('online',()=>recoverCatalog())"), 'web catalog revalidates when connectivity returns');
  step(backendSrc.includes("'/api/current'") && backendSrc.includes("cache:'no-store'") && backendSrc.includes('If-None-Match'), 'catalog pointer check bypasses HTTP cache but sends validators');
  // 网页音频：完整条目不可变，模块里没有任何 TTL/后台重验证/条件请求。
  step(!/revalidat|max-age|stale-while|If-None-Match/i.test(audioSrc), 'web audio cache has no revalidation policy at all (immutable complete entries)');
  step(!page.includes('prepareWebAudio(') && !page.includes('primeWebAudioCacheIndex'), 'catalog page never triggers audio revalidation');
}

// ============ S16：迟到的旧目录响应不能覆盖已提交的新 revision（#19） ============
{
  freshKv(); onlineFetch(); nativeMode = false;
  const B = await boot(); B.resetCatalog();
  routes = [];
  const first = deferred(), second = deferred();
  let catalogCalls = 0;
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => { catalogCalls += 1; return catalogCalls === 1 ? first.promise : second.promise; });
  const stale = B.fetchIndex();
  await sleep(10);
  step(catalogCalls >= 1, 'first catalog request is in flight');
  const fresh = B.fetchIndex({ force: true }); // 退休旧操作
  second.resolve(jsonRes(catalogFixture('rev-LATE-NEW')));
  await fresh;
  first.resolve(jsonRes(catalogFixture('rev-LATE-OLD')));
  await stale; await sleep(20);
  step(B.backend.manifest?.revision === 'rev-LATE-NEW', 'late older response never overwrites the newer committed revision');
  step(B.backend.error === '', 'retired operation does not poison the new one');
}

// ============ S17：音频优先（owner 裁定 ④）：有音频缓存的月份在 3 月上限内被保护 ============
{
  freshKv();
  const ids = ['2024-01', '2024-02', '2024-03', '2024-04'];
  const m = catalogFixture('rev-P', ids);
  await O.saveManifestSnapshot('', m);
  for (const id of ids) {
    await O.saveMonthSnapshot('', m, id, monthFixture(id, 'rev-P').audios, { protectedMonths: ['2024-01'] });
    await flush();
    await sleep(3);
  }
  const p = JSON.parse(await kv.get('aof|p|same-origin'));
  step(Object.keys(p.months).length === 3, 'protected selection stays bounded by maxMonths=3');
  step(!!p.months['2024-01'], 'month with cached audio is kept even when it is the oldest');
  step(!p.months['2024-02'], 'the oldest unprotected month yields the slot');
  step(await kv.get('aof|M|same-origin|rev-P|2024-02') === null, 'dropped month doc is pruned');
  step(await kv.get('aof|M|same-origin|rev-P|2024-01') !== null, 'protected month doc remains on disk');
}

// ============ S18：backend 接线：内存裁剪后仍保护有音频缓存的月份 ============
{
  freshKv(); cachedAudioUrls.clear(); onlineFetch(); nativeMode = false;
  routes = [];
  const B = await boot(); B.resetCatalog();
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-AUDIO')));
  for (const id of MONTH_IDS) on('/api/month/' + id, () => jsonRes(monthFixture(id, 'rev-AUDIO')));
  cachedAudioUrls.add('/api/2023-11-1.opus'); // fixture 的 opus → 稳定键
  await B.fetchIndex(); await flush();
  for (const id of MONTH_IDS) { await B.loadMonth(id); await flush(); await sleep(3); }
  const p = JSON.parse(await kv.get('aof|p|same-origin'));
  step(p.revision === 'rev-AUDIO' && Object.keys(p.months).length === 3, 'snapshot still bounded to 3 months');
  step(!!p.months['2023-11'], 'backend keeps the cached-audio month after memory trim');
  step(!p.months['2023-12'], 'unprotected older month is the one dropped');
  cachedAudioUrls.clear();
}

console.log(`catalog offline tests passed: ${checks} checks (hydrate/save atomicity, origin isolation, network-vs-restore ownership both ways, quota/too-large non-blocking, 3-month LRU bound, audio-first protected months, revalidation cadence, TypeError-only serving, corrupt rejection, default storage selection, no-storage degradation)`);
process.exit(0);
