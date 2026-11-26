// 后台恢复回归测试：用 vite-node 编译并驱动真实 backend.svelte.ts（Svelte runes），
// 覆盖：有界超时 settle/可重试、挂死 pending 可退休、reset 立即解锁且旧响应不覆盖、
// 304 清错误并放行失败月份、目录失败保留已有内容、生命周期事件合并、刷新数据不动播放器/存储、
// 原生桥不响应 abort 时降级为普通 fetch。运行：npx vite-node scripts/test-background-recovery.mjs
import assert from 'node:assert/strict';
import { monthBounds } from '../src/lib/month.js';

let nativeMode = false;
let bridgeHandler = async () => null;
let reloadCalls = 0;
let storageWrites = 0;
const store = new Map();
const ls = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => { storageWrites++; store.set(k, String(v)); },
  removeItem: k => store.delete(k),
};
const winListeners = {};
globalThis.window = {
  localStorage: ls,
  location: { reload() { reloadCalls++; } },
  addEventListener: (t, f) => { (winListeners[t] ??= []).push(f); },
  removeEventListener: (t, f) => { winListeners[t] = (winListeners[t] ?? []).filter(v => v !== f); },
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: { setActionHandler() {}, setPositionState() {} } }, configurable: true });
globalThis.MediaMetadata = class {};
globalThis.Audio = class extends EventTarget { paused = true; currentTime = 0; duration = 100; src = ''; load() {} play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } removeAttribute() { this.src = ''; } };
globalThis.localStorage = ls;

const { ViteNodeRunner } = await import('vite-node/client');
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
  return original.call(this, id, fsPath, callstack);
};

const rec = await import('../src/lib/catalog-recovery');
const B = await import('../src/lib/backend.svelte.ts');
const P = await import('../src/lib/player.svelte.ts');

rec.configureCatalogTimeouts({ requestMs: 120, operationMs: 4000, nativeBridgeMs: 40, coalesceMs: 30 });
const COALESCE = 30, REQUEST_MS = 120;

// —— fetch/桥 测试装置 ——
let routes = [], fetchLog = [];
// 真实环境里 web fetch 会响应 abort；这里在模块加载后接管全局 fetch（覆盖 SvelteKit 的开发期守卫），
// 每个场景先 resetCatalog()+routes=[] 再按需注册路由。
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const hit = routes.find(r => u.includes(String(r.sub)));
  if (!hit) throw Error('no fetch route for ' + u);
  fetchLog.push({ url: u, opts });
  return hit.handler(u, opts);
};
const on = (sub, handler) => routes.push({ sub, handler });
const nOf = sub => fetchLog.filter(e => String(e.url).includes(sub)).length;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const abortErr = () => new DOMException('Aborted', 'AbortError');
// 真实浏览器的 fetch 会响应 abort；只有原生桥（bridgeHandler）可能永不 settle。
const hungSignal = (u, opts) => new Promise((_, rej) => {
  const s = opts?.signal;
  if (s?.aborted) { rej(abortErr()); return; }
  s?.addEventListener('abort', () => rej(abortErr()), { once: true });
});
const pointerRes = (etag = null) => ({ ok: true, status: 200, headers: { get: k => (String(k).toLowerCase() === 'etag' ? etag : null) }, json: async () => ({ schemaVersion: 2, releaseId: 'a'.repeat(64) }) });
const jsonRes = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const failRes = status => ({ ok: false, status, headers: { get: () => null }, json: async () => { throw Error('no body'); } });
const audioIn = (audioId, monthId, bounds) => ({ id: audioId, file: audioId + '.wav', opus: audioId + '.opus', title: audioId, startAt: bounds.startAt + 86400 * 2, duration: 100, lyrics: [], monthId });
const catalogFixture = revision => ({
  schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: 1700000000, revision,
  months: ['2024-01', '2024-02'].map(id => { const b = monthBounds(id); return { id, startAt: b.startAt, endAt: b.endAt, count: 1, revision: 'm-' + id, key: id + '.json', available: true }; }),
});
const monthFixture = id => ({ schemaVersion: 2, id, revision: 'm-' + id, audios: [audioIn(id + '-1', id, monthBounds(id))] });
const webMode = () => { nativeMode = false; bridgeHandler = async () => null; B.resetCatalog(); routes = []; fetchLog = []; };
const waitIdle = async () => { for (let i = 0; i < 300; i++) { if (!B.backend.pending) return; await sleep(10); } throw Error('pending never cleared'); };
let checks = 0;
const step = (cond, msg) => { assert.ok(cond, msg); checks++; };

// ============ S0：catalog-recovery 纯行为 ============
{
  step(rec.catalogTimeouts().requestMs === 120, 'configured timeouts applied');
  rec.configureCatalogTimeouts({ requestMs: -5 });
  step(rec.catalogTimeouts().requestMs === 120, 'invalid overrides ignored');
  step(rec.catalogTimeouts().requestMs === 120 && (() => { const s = rec.catalogTimeouts(); s.requestMs = 1; return rec.catalogTimeouts().requestMs === 120; })(), 'catalogTimeouts returns copy');
  rec.configureCatalogTimeouts({ requestMs: REQUEST_MS });

  const t0 = Date.now();
  await assert.rejects(rec.bounded(() => new Promise(() => {}), { timeoutMs: 30 }), e => e.name === 'CatalogTimeoutError', 'timeout rejects even when underlying ignores abort');
  step(Date.now() - t0 >= 25, 'timeout waited about the cap');

  const late = deferred();
  await assert.rejects(rec.bounded(() => late.promise, { timeoutMs: 15 }));
  late.resolve('stale');
  await sleep(30); // 迟到结果被吞掉：无 unhandled rejection，Promise 状态不变
  step(true, 'late result after timeout is discarded');

  let innerSignal = null;
  const c = new AbortController();
  const p = rec.bounded(s => { innerSignal = s; return new Promise(() => {}); }, { timeoutMs: 5000, signal: c.signal });
  await sleep(5);
  c.abort();
  const t1 = Date.now();
  await assert.rejects(p, e => e.name === 'AbortError', 'external abort settles immediately');
  step(Date.now() - t1 < 50, 'external abort did not wait for underlying');
  step(innerSignal.aborted === true, 'internal signal still aborted best-effort');

  let ran = false;
  const c2 = new AbortController(); c2.abort();
  await assert.rejects(rec.bounded(() => { ran = true; return Promise.resolve(1); }, { signal: c2.signal }), e => e.name === 'AbortError');
  step(ran === false, 'pre-aborted signal never starts the task');
  ran = false;
  await assert.rejects(rec.bounded(() => { ran = true; return Promise.resolve(1); }, { timeoutMs: 0 }));
  step(ran === false, 'non-positive budget never starts the task');
  step(await rec.bounded(async () => 7, { timeoutMs: 50 }) === 7, 'success path passes value');

  const now = Date.now();
  step(rec.shouldRetireOperation(now - 4001, now) === true, 'expired operation retirable');
  step(rec.shouldRetireOperation(now - 10, now) === false, 'young operation not expired');
}

// ============ S1：阶段超时 settle、挂死 pending 可退休、恢复后可重试 ============
{
  webMode();
  on('/api/current', () => pointerRes());
  on('/api/catalog', hungSignal);
  const t0 = Date.now();
  await B.fetchIndex();
  const el = Date.now() - t0;
  step(B.backend.pending === false, 'pending cleared after stage timeout');
  step(/超时/.test(B.backend.error), 'timeout surfaces as visible error: ' + B.backend.error);
  step(B.backend.manifest === null, 'nothing committed on failure');
  step(el >= 90 && el < 2500, 'settled around the request cap (' + el + 'ms)');

  // 请求挂死（不回 abort 前的常态：等待阶段超时）期间，force 恢复退休它并重新发起
  const p1 = B.fetchIndex();
  await sleep(10);
  step(B.backend.pending === true, 'op in flight marks pending');
  const before = nOf('/api/catalog');
  const p2 = B.fetchIndex({ force: true });
  await sleep(5);
  step(nOf('/api/catalog') === before + 1, 'force recovery reissues instead of waiting forever');
  step(B.backend.pending === true, 'new op owns pending after retirement');
  await p1; await p2;
  step(B.backend.pending === false, 'both chains settle with bounded timeouts');
  step(/超时/.test(B.backend.error), 'failure still visible');

  // 服务恢复 → 重试成功；不得自行全量批抓历史
  routes = routes.filter(r => !r.sub.includes('/api/catalog'));
  on('/api/catalog', () => jsonRes(catalogFixture('rev-s1')));
  await B.fetchIndex();
  step(B.backend.manifest?.revision === 'rev-s1', 'retry after recovery succeeds');
  step(B.backend.error === '', 'successful fetch clears connection error');
  step(Object.keys(B.backend.months).length === 0, 'fetchIndex does not bulk-load history months');
}

// ============ S1c：超过操作期限的残留请求，普通 fetchIndex 即可退休 ============
{
  webMode();
  let first = true;
  on('/api/current', (u, opts) => { if (first) { first = false; return hungSignal(u, opts); } return Promise.resolve(pointerRes()); });
  on('/api/catalog', () => jsonRes(catalogFixture('rev-retired')));
  rec.configureCatalogTimeouts({ operationMs: 60 });
  const p = B.fetchIndex();
  await sleep(90); // 操作期限 60ms 已过（模拟后台冻结定时器导致 never-settle 的残留）
  const q = B.fetchIndex(); // 普通调用（非 force）也应退休残留并重新发起
  await p; await q;
  step(B.backend.manifest?.revision === 'rev-retired', 'expired residual request retired and refetch succeeded');
  step(B.backend.pending === false, 'pending released');
  rec.configureCatalogTimeouts({ operationMs: 4000 });
}

// ============ S2：resetCatalog 立即清 pending；新请求完成；旧响应不覆盖/不解锁 ============
{
  webMode();
  const dOld = deferred(), dNew = deferred();
  let first = true;
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => { const d = first; first = false; return (d ? dOld : dNew).promise; });
  const p1 = B.fetchIndex();
  await sleep(5);
  step(B.backend.pending === true, 'first op pending');
  B.resetCatalog();
  step(B.backend.pending === false, 'resetCatalog clears pending immediately');
  const p2 = B.fetchIndex();
  await sleep(5);
  step(B.backend.pending === true, 'new op pending while old chain winding down');
  dOld.resolve(jsonRes(catalogFixture('rev-old'))); // 迟到的旧响应
  await sleep(30);
  step(B.backend.pending === true, 'old finally does not unlock the new operation');
  step(B.backend.manifest === null, 'old response cannot commit');
  dNew.resolve(jsonRes(catalogFixture('rev-new')));
  await p2;
  step(B.backend.manifest?.revision === 'rev-new', 'new request completes after reset');
  await p1;
  step(B.backend.manifest?.revision === 'rev-new', 'stale response never overwrites');
  step(B.backend.error === '', 'aborted old chain does not pollute error state');
  step(B.backend.pending === false, 'pending owned by new op only');
}

// ============ S2b：主会话复现 #2——pointer 挂死且不响应 abort，reset 后新 fetchIndex 不被挡；旧响应迟到的 503 不重新锁死 ============
{
  webMode();
  const dHang = deferred();
  let first = true;
  on('/api/current', () => { if (first) { first = false; return dHang.promise; } return Promise.resolve(pointerRes()); }); // 旧 mock：完全不响应 abort
  on('/api/catalog', () => jsonRes(catalogFixture('rev-s2b')));
  const p1 = B.fetchIndex();
  await sleep(5);
  step(B.backend.pending === true && nOf('/api/current') === 1, 'hung pointer op in flight');
  B.resetCatalog();
  step(B.backend.pending === false, 'reset unblocks even when the underlying fetch ignores abort');
  const p2 = B.fetchIndex();
  await p2;
  step(nOf('/api/current') === 2, 'new fetchIndex is not blocked (calls===2)');
  step(B.backend.manifest?.revision === 'rev-s2b', 'new op completes after reset');
  dHang.resolve(failRes(503)); // 旧请求以 503 迟到结束
  await p1;
  await sleep(30);
  step(B.backend.pending === false, 'late stale 503 cannot re-lock pending');
  step(B.backend.error === '' && B.backend.manifest?.revision === 'rev-s2b', 'stale 503 cannot pollute error or manifest');
}

// ============ S3：失败保留已有目录；304 清错误并放行失败月份重试 ============
{
  webMode();
  on('/api/current', () => pointerRes('ETAG-1'));
  on('/api/catalog', () => jsonRes(catalogFixture('rev-e1')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01')));
  on('/api/month/2024-02', () => failRes(500));
  await B.fetchIndex();
  step(B.backend.manifest?.revision === 'rev-e1', 'catalog committed');
  await B.loadMonth('2024-01');
  step(!!B.backend.summaries['2024-01'], 'month 01 loaded');
  await assert.rejects(B.loadMonth('2024-02'));
  step(!!B.backend.errors['2024-02'], 'failed month gated by error');

  // 连接失败：错误可见，已有 manifest/months/summaries 一律保留
  const prevManifest = B.backend.manifest, prevMonths = B.backend.months, prevSummaries = B.backend.summaries;
  routes.unshift({ sub: '/api/current', handler: () => Promise.reject(Error('boom-net')) });
  await B.fetchIndex();
  step(B.backend.error === 'boom-net', 'failure visible: ' + B.backend.error);
  step(B.backend.manifest === prevManifest && B.backend.months === prevMonths && B.backend.summaries === prevSummaries, 'failure keeps existing catalog and months');
  step(!!B.backend.errors['2024-02'], 'failed-month gating survives a failed refresh (no hammering)');

  // 恢复：304 → 清旧 error + 放行失败月份；不重新拉 catalog、不动已加载历史
  routes = [];
  let etagSeen = null, catalogAgain = 0;
  on('/api/current', (u, opts) => { etagSeen = opts?.headers?.['If-None-Match'] ?? null; return Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, json: async () => { throw Error('304 body'); } }); });
  on('/api/catalog', () => { catalogAgain++; return Promise.resolve(jsonRes(catalogFixture('rev-e1'))); });
  await B.fetchIndex();
  step(etagSeen === 'ETAG-1', '304 check sends the stored etag');
  step(B.backend.error === '', '304 clears the stale connection error');
  step(!B.backend.errors['2024-02'], 'failed month rearmed for retry');
  step(B.backend.manifest === prevManifest && B.backend.months === prevMonths && B.backend.summaries === prevSummaries, '304 keeps valid months/history (no refetch, no clear)');
  step(catalogAgain === 0, '304 does not refetch the catalog');

  // 放行后可成功重试该月份
  on('/api/month/2024-02', () => jsonRes(monthFixture('2024-02')));
  const a2 = await B.loadMonth('2024-02');
  step(a2.length === 1 && !!B.backend.summaries['2024-02'], 'rearmed month loads successfully');

  // loadMonth 也有界：挂起的月份请求超时 settle、状态解锁、之后可重试成功
  webMode();
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-m')));
  on('/api/month/2024-01', hungSignal);
  await B.fetchIndex();
  const t0 = Date.now();
  await assert.rejects(B.loadMonth('2024-01'), e => e.name === 'CatalogTimeoutError', 'loadMonth bounded by request timeout');
  step(Date.now() - t0 >= 90, 'loadMonth waited about the cap');
  step(B.backend.loading['2024-01'] === false, 'loading flag released after timeout');
  step(/超时/.test(B.backend.errors['2024-01'] ?? ''), 'month timeout visible via errors');
  routes = routes.filter(r => r.sub !== '/api/month/2024-01');
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01')));
  const a1 = await B.loadMonth('2024-01');
  step(a1.length === 1, 'month retry after timeout succeeds');
}

// ============ S4：生命周期事件合并；隐藏不发请求；普通刷新不打断健康请求；force 退休健康请求 ============
{
  webMode();
  rec.configureCatalogTimeouts({ requestMs: 2000 }); // 本场景考察调度而非超时，阶段上限放宽
  const d1 = deferred();
  let sig1 = null;
  on('/api/current', (u, opts) => { sig1 = opts?.signal ?? null; return d1.promise; });
  B.initBackend(); // 直接 fetchIndex 一次（在途），并注册 online
  const started = nOf('/api/current');
  step(started === 1, 'initBackend issues the first fetch');
  B.recoverCatalog(); B.recoverCatalog(); B.recoverCatalog();
  await sleep(COALESCE * 2 + 10);
  step(nOf('/api/current') === started, 'coalesced lifecycle recovery dedupes against the healthy in-flight request');
  step(B.backend.pending === true, 'lifecycle recovery never aborted the healthy op');
  step(sig1 && sig1.aborted === false, 'normal lifecycle recovery does not cancel a healthy request');

  globalThis.document.visibilityState = 'hidden';
  B.recoverCatalog(); B.recoverCatalog({ force: true });
  await sleep(COALESCE * 3);
  step(nOf('/api/current') === started, 'hidden page issues no background requests');
  globalThis.document.visibilityState = 'visible';

  d1.resolve(pointerRes());
  routes.push({ sub: '/api/catalog', handler: () => jsonRes(catalogFixture('rev-s4')) });
  await waitIdle();
  step(B.backend.manifest?.revision === 'rev-s4', 'single pointer fetch served all lifecycle events');

  // 合并窗口中重新切后台：timer 到点也不能发后台请求。
  const beforeHiddenTimer = nOf('/api/current');
  B.recoverCatalog();
  globalThis.document.visibilityState = 'hidden';
  await sleep(COALESCE * 2 + 10);
  step(nOf('/api/current') === beforeHiddenTimer, 'queued recovery rechecks visibility before starting');
  globalThis.document.visibilityState = 'visible';

  // online 事件走同一合并入口
  const n = nOf('/api/current');
  (winListeners.online ?? []).forEach(f => f());
  (winListeners.online ?? []).forEach(f => f());
  await sleep(COALESCE * 2 + 10);
  step(nOf('/api/current') === n + 1, 'online events coalesce into exactly one refresh');

  // force 恢复（顶栏「刷新数据」）退休年轻健康请求并重新发起
  const d2 = deferred();
  let sig2 = null;
  const nF = nOf('/api/current');
  routes = routes.filter(r => !r.sub.includes('/api/current'));
  let curFirst = true;
  on('/api/current', (u, opts) => { if (curFirst) { curFirst = false; sig2 = opts?.signal ?? null; return d2.promise; } return Promise.resolve(pointerRes()); });
  const p = B.fetchIndex();
  await sleep(5);
  B.recoverCatalog({ force: true });
  step(sig2?.aborted === true, 'force recovery retires the in-flight request immediately');
  d2.resolve(pointerRes()); // 迟到的旧请求结果（其链已退休）
  await p;
  await sleep(COALESCE + 120);
  await waitIdle();
  step(nOf('/api/current') === nF + 2, 'force recovery retired the old request and reissued a new one');
  step(B.backend.manifest?.revision === 'rev-s4', 're-issued refresh keeps working');
  rec.configureCatalogTimeouts({ requestMs: REQUEST_MS });
}

// ============ S5：原生桥不响应 abort：有界超时后降级普通 fetch；已有目录保留 ============
{
  webMode();
  nativeMode = true;
  B.backend.base = 'https://native.test';
  on('/api/current', () => pointerRes('NE'));
  on('https://native.test/api/catalog', () => jsonRes(catalogFixture('rev-fallback')));
  // (a) 桥正常：命中原生缓存，不走网络 catalog
  bridgeHandler = async () => ({ data: catalogFixture('rev-bridge'), source: 'cache' });
  await B.fetchIndex();
  step(B.backend.manifest?.revision === 'rev-bridge', 'native bridge result committed');
  step(nOf('/api/catalog') === 0, 'bridge hit does not touch network catalog');
  // (b) 桥永久挂起（不响应任何中止手段）：降级普通 fetch 成功
  bridgeHandler = () => new Promise(() => {});
  const t0 = Date.now();
  await B.fetchIndex();
  step(B.backend.manifest?.revision === 'rev-fallback', 'hung bridge degrades to plain fetch');
  step(Date.now() - t0 >= 30, 'hung bridge stage respected its cap');
  step(B.backend.error === '', 'degraded success leaves no error');
  // (c) 桥挂起且网络也挂起：阶段超时，已有目录完整保留，pending 解锁
  const keepManifest = B.backend.manifest;
  routes = routes.filter(r => !String(r.sub).includes('/api/catalog'));
  on('/api/catalog', hungSignal);
  await B.fetchIndex();
  step(B.backend.manifest === keepManifest, 'hung bridge + hung network keeps loaded manifest');
  step(/超时/.test(B.backend.error), 'combined hang surfaces bounded timeout');
  step(B.backend.pending === false, 'native path never leaves pending stuck');
  // (d) 桥仍挂起但网络恢复：重试成功
  routes = routes.filter(r => !String(r.sub).includes('/api/catalog'));
  on('/api/catalog', () => jsonRes(catalogFixture('rev-recovered')));
  await B.fetchIndex();
  step(B.backend.manifest?.revision === 'rev-recovered', 'retry succeeds with bridge still hung');
  nativeMode = false;
  bridgeHandler = async () => null;
}

// ============ S6：强制刷新数据不改播放器队列 / 不写存储 / 不 reset / 从不自动 reload ============
{
  webMode();
  on('/api/current', () => pointerRes());
  on('/api/catalog', () => jsonRes(catalogFixture('rev-s6')));
  on('/api/month/2024-01', () => jsonRes(monthFixture('2024-01')));
  await B.fetchIndex();
  await B.loadMonth('2024-01');
  const pl = { id: 'pl', file: 'pl.wav', opus: 'pl.opus', title: 'pl', startAt: 1700000000, duration: 100, lyrics: [], monthId: '2023-11' };
  P.playAudio(pl);
  await sleep(450); // 等播放器 300ms 防抖的会话写入落盘后再快照
  const queueSnap = JSON.stringify({ playlist: P.player.playlist.map(t => t.queueEntryId), pos: P.player.pos, track: P.player.track?.audio.id ?? null, history: P.player.history });
  const storeSnap = JSON.stringify([...store.entries()].sort());
  const writesBefore = storageWrites;
  const genBefore = B.backend.generation, manifestRef = B.backend.manifest, monthsRef = B.backend.months, summariesRef = B.backend.summaries;

  // 挂一个在途目录请求，然后走「刷新数据」同款路径：recoverCatalog({force:true})
  routes = routes.filter(r => !String(r.sub).includes('/api/catalog'));
  on('/api/catalog', hungSignal);
  const p = B.fetchIndex();
  await sleep(5);
  B.recoverCatalog({ force: true });
  await p;
  await sleep(COALESCE + REQUEST_MS + 80); // 让合并窗口后的重发也完整超时落定
  await waitIdle();

  step(JSON.stringify({ playlist: P.player.playlist.map(t => t.queueEntryId), pos: P.player.pos, track: P.player.track?.audio.id ?? null, history: P.player.history }) === queueSnap, 'force recovery leaves the player queue untouched');
  step(B.backend.generation === genBefore, 'force recovery does not reset the catalog');
  step(B.backend.manifest === manifestRef && B.backend.months === monthsRef && B.backend.summaries === summariesRef, 'loaded backend state preserved through recovery');
  step(JSON.stringify([...store.entries()].sort()) === storeSnap && storageWrites === writesBefore, 'refresh writes nothing to storage');
  step(reloadCalls === 0, 'nothing auto-reloaded the page');
}

// ============ S7：主会话复现 #1——合法空 months 目录 + error='Load failed' + 304 后 error 必清 ============
{
  webMode();
  const manifestEmpty = { schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: 1, revision: 'rev-empty', months: [] };
  B.backend.manifest = manifestEmpty;
  B.backend.error = 'Load failed';
  on('/api/current', () => Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, json: async () => { throw Error('304 body'); } }));
  await B.fetchIndex();
  step(B.backend.error === '', '304 with loaded manifest clears Load failed (repro #1 fixed)');
  step(B.backend.manifest === manifestEmpty, '304 keeps the existing manifest object');
  step(B.backend.pending === false, '304 path releases pending');
}

// ============ S8：UI 编译+组件断言（仓库无 playwright/chromium，按主会话指示不装；行为级主体验证归主会话） ============
{
  const { compile, preprocess } = await import('svelte/compiler');
  const { vitePreprocess } = await import('@sveltejs/vite-plugin-svelte');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const compileSvelte = async rel => {
    const src = await readFile(path.join(root, rel), 'utf8');
    const out = await preprocess(src, [vitePreprocess()], { filename: rel });
    return { src, code: compile(out.code, { filename: rel, generate: 'client' }).js.code };
  };
  const menu = await compileSvelte('src/lib/components/RefreshMenu.svelte');
  step(/from '\$lib\/backend.svelte'/.test(menu.src) && /recoverCatalog/.test(menu.code), 'RefreshMenu compiles and wires recoverCatalog');
  step(/recoverCatalog\(\{\s*force:\s*true\s*\}\)/.test(menu.code) || /recoverCatalog\(\{force:!0\}\)/.test(menu.code), 'refresh-data calls force recovery');
  step(/window\.location\.reload\(\)/.test(menu.code) && /confirmReload/.test(menu.code), 'reload is a real location.reload behind explicit confirm state');
  step(!/disabled/.test(menu.src), 'no disabled gate: hung pending can never disable the menu buttons');
  step(/backend\.pending/.test(menu.code), 'busy state derives from backend.pending');
  const page = await compileSvelte('src/routes/+page.svelte');
  step(/RefreshMenu/.test(page.code), 'header mounts RefreshMenu for web and App');
  step(/recoverCatalog\(\{\s*force:\s*true\s*\}\)/.test(page.code), 'inline retry button routes through force recovery');
  step(!/location\.reload/.test(page.code), 'page itself never reloads (no automatic reload in interval/lifecycle paths)');
  step(/setInterval\(refresh,\s*30000\)/.test(page.src) && /recoverCatalog\(\)/.test(page.src), '30s tick stays a plain fetchIndex; lifecycle uses coalesced recovery');
}

console.log(`background recovery tests passed: ${checks} checks (bounded settle, retire, reset-unlock incl abort-ignoring fetch, 304 rearms + Load-failed repro, coalescing, native degradation, player/storage untouched, UI compile assertions)`);
process.exit(0);
