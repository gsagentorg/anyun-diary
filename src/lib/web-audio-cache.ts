/**
 * 网页音频离线缓存：CacheStorage（完整 200 条目）+ Blob URL 播放。
 *
 * 与原生缓存的分工（docs/web-offline-cache.md）：
 * - 本模块只服务浏览器网页环境；Capacitor App 内稳定 HTTPS 由 AVPlayer 查询原生磁盘缓存，不经过这里。
 * - service worker（src/service-worker.ts）只缓存应用 shell / 页面快照，从不碰音频字节；音频归本模块独占管理。
 *
 * 红线：
 * - 只缓存完整 200 的非 opaque 响应（拒 opaque/error）；206 / 截断（Content-Length 不符）/ 空 body / 非音频 Content-Type 一律不入缓存。
 * - 持久 key 用剥离 query/hash 的稳定 URL：严格同源 `/api/audio/<64hex>.opus`，或无凭证的绝对 http(s) 音频 URL；
 *   签名地址与 token 绝不进缓存条目、元数据或 localStorage。
 * - LRU 按上限（默认 512MB，与 App 一致）真实有界；配额失败先逐出再重试，绝不破坏播放。
 * - clear 递增序列 token，在途下载/写入被中止且不会在清理后复活；正在播放的 Blob URL 只在 release 后才进入回收。
 * - 一切故障都降级为「按原 URL 在线播放」，永不抛致命错误；缓存完成前不宣布可离线。
 *
 * 本文件刻意保持零依赖（不 import svelte / $app / capacitor），可被 node 直跑测试加载。
 */

export const WEB_AUDIO_CACHE_NAME = 'anyun-web-audio-v1';
/** 与 App 的 DEFAULT_CACHE_POLICY.maxBytes 一致（512MB）。 */
export const DEFAULT_WEB_AUDIO_MAX_BYTES = 536_870_912;
export const WEB_AUDIO_MIN_BYTES = 1_048_576;
export const WEB_AUDIO_MAX_LIMIT = 4_294_967_296;
/** 单曲上限：超过即放弃缓存（播放不受影响）。切片实际远小于此，这是防御性兜底。 */
export const WEB_AUDIO_MAX_ENTRY_BYTES = 104_857_600;
export const WEB_AUDIO_MAX_PARALLEL_DOWNLOADS = 2;

const LIMIT_STORAGE_KEY = 'anyun-web-audio-limit-v1';
const LRU_STORAGE_KEY = 'anyun-web-audio-lru-v1';
const SIZE_HEADER = 'x-anyun-bytes';
const STORED_HEADER = 'x-anyun-stored-at';
const HEADER_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 180_000;
/** release 后延迟 revoke：给正在/即将用该 URL 的元素留极短安全窗，切曲释放仍是秒级回收。 */
const BLOB_GRACE_MS = 1_500;
const SAME_ORIGIN_PATH = /^\/api\/audio\/[a-f0-9]{64}\.opus$/;
const CROSS_AUDIO_PATH = /\.(?:opus|ogg|oga|mp3|m4a|aac|wav|weba|flac)$/i;
const CACHEABLE_CT = /^(?:audio|video)\//i;
const CACHEABLE_CT_EXACT = new Set(['application/ogg', 'application/octet-stream', 'application/mp4', 'application/x-wav']);
const NOOP = () => {};

export interface WebCacheStats {
  bytes: number;
  entries: number;
  maxBytes: number;
  supported: boolean;
  downloading: number;
}

export interface WebAudioHandle {
  url: string;
  /** 幂等释放；引用清零后延迟 revoke。 */
  release: () => void;
}

export interface WebAudioPrepared {
  /** 命中完整缓存 → blob: URL；未命中 → 原样传回 stableUrl（正常在线播放，不必等下载）。 */
  url: string;
  release: () => void;
  /** 仅当本次直接以完整缓存条目可播时 true。 */
  cached: boolean;
  /** 规范化后的持久 key；null=该地址不允许进缓存。 */
  stableUrl: string | null;
  /** 后台下载结果（true=已完整入缓存），永不 reject；命中或不可缓存时为已定值。 */
  done: Promise<boolean>;
}

export type WebCacheEvent =
  | { type: 'cached'; stableUrl: string; bytes: number }
  | { type: 'failed'; stableUrl: string; reason: string }
  | { type: 'evicted'; stableUrl: string; bytes: number }
  | { type: 'cleared'; stableUrl?: undefined };

export interface PrepareOptions {
  /** 中止后台缓存下载（不影响本次播放地址的返回）。 */
  signal?: AbortSignal;
  /** 覆盖相对地址的解析基准（测试/特殊部署用；默认取 location.origin 或 configureWebCacheOrigin）。 */
  base?: string;
}

interface CacheStorageLike {
  open: (name: string) => Promise<{
    match: (req: string) => Promise<Response | undefined>;
    matchAll: () => Promise<Response[]>;
    keys: () => Promise<Array<{ url: string }>>;
    put: (req: string, res: Response) => Promise<void>;
    delete: (req: string) => Promise<boolean>;
  }>;
  delete: (name: string) => Promise<boolean>;
}

interface BlobEntry {
  url: string;
  key: string;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** clear 之后不再对外命中，但已发出的 handle 保持可用。 */
  zombie: boolean;
}

interface Inflight {
  controller: AbortController;
  promise: Promise<boolean>;
}

const listeners = new Set<(event: WebCacheEvent) => void>();
const blobs = new Map<string, BlobEntry>();
const inflight = new Map<string, Inflight>();
const sizes = new Map<string, number>();
const access = new Map<string, number>();
let injectedOrigin: string | null = null;
let indexWarm: Promise<void> | null = null;
let clearToken = 0;
let memoryLimit: number | null = null;
let writes: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task); writes = next.catch(() => {}); return next;
}
let activeDownloads = 0;
const slotWaiters: Array<() => void> = [];
let lruPersistTimer: ReturnType<typeof setTimeout> | null = null;
let releasedBlobUrls: Array<string> = []; // 诊断/测试：记录被 revoke 的 blob url

function emit(event: WebCacheEvent) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* UI 监听器异常不得影响缓存 */
    }
  }
}

function store(): Storage | undefined {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : undefined;
  } catch {
    return undefined; // 隐私模式等：localStorage 访问即抛
  }
}

function cacheStorage(): CacheStorageLike | null {
  const c = (globalThis as unknown as { caches?: CacheStorageLike }).caches;
  if (!c || typeof c.open !== 'function' || typeof c.delete !== 'function') return null;
  return c;
}

/** CacheStorage + fetch + Blob URL 三者齐备才可用；否则一切 API 都走在线降级。 */
export function webCacheAvailable(): boolean {
  return (
    cacheStorage() !== null &&
    typeof (globalThis as { fetch?: unknown }).fetch === 'function' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/** 测试/无 location 环境注入相对地址的解析基准；传 null 恢复默认。 */
export function configureWebCacheOrigin(origin: string | null): void {
  injectedOrigin = origin;
}

function locationOrigin(base?: string): string | null {
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      return null;
    }
  }
  if (injectedOrigin) return injectedOrigin;
  try {
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    return href ? new URL(href).origin : null;
  } catch {
    return null;
  }
}

/**
 * 持久 key：剥离 query/hash（resolve/签名参数绝不入 key）、要求 http(s) 无凭证。
 * 同源只接受严格的 /api/audio/<64hex>.opus；跨域只接受路径带音频扩展名的绝对 URL。
 * 不合规返回 null（调用方一律在线降级）。
 */
export function normalizeWebCacheKey(raw: string, base?: string): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const origin = locationOrigin(base);
  let url: URL;
  try {
    url = origin ? new URL(raw, origin) : new URL(raw);
  } catch {
    return null; // 相对地址且无可用基准 → 拒绝（降级，不抛）
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  const sameOrigin = origin !== null && url.origin === origin;
  if (sameOrigin ? !SAME_ORIGIN_PATH.test(url.pathname) : !CROSS_AUDIO_PATH.test(url.pathname)) return null;
  return url.href;
}

function maxBytes(): number {
  if (memoryLimit !== null) return memoryLimit;
  const raw = Number(store()?.getItem(LIMIT_STORAGE_KEY));
  return clampLimit(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WEB_AUDIO_MAX_BYTES);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WEB_AUDIO_MAX_BYTES;
  return Math.min(WEB_AUDIO_MAX_LIMIT, Math.max(WEB_AUDIO_MIN_BYTES, Math.round(value)));
}

function touch(key: string) {
  access.set(key, Date.now());
  if (lruPersistTimer) clearTimeout(lruPersistTimer);
  lruPersistTimer = setTimeout(() => {
    lruPersistTimer = null;
    persistLru();
  }, 800);
  // 测试进程不被 pending 定时器拖住时可忽略；浏览器无此问题。
  (lruPersistTimer as unknown as { unref?: () => void })?.unref?.();
}

function persistLru() {
  try {
    const entries: Record<string, number> = {};
    for (const key of sizes.keys()) entries[key] = access.get(key) ?? 0;
    store()?.setItem(LRU_STORAGE_KEY, JSON.stringify(entries)); // key 已剥离签名，可安全落盘
  } catch {
    /* 存储不可用：LRU 退化为内存序，仍是有界淘汰 */
  }
}

function restoreLru() {
  try {
    const raw = store()?.getItem(LRU_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [key, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) access.set(key, ts);
    }
  } catch {
    /* 忽略坏数据 */
  }
}

function totalBytes(): number {
  let sum = 0;
  for (const value of sizes.values()) sum += value;
  return sum;
}

function openCache() {
  return cacheStorage()!.open(WEB_AUDIO_CACHE_NAME);
}

/** 把缓存索引（key→bytes、访问序）装载进内存；只读 header，不搬运音频体。 */
function ensureIndex(): Promise<void> {
  if (indexWarm) return indexWarm;
  indexWarm = (async () => {
    try {
      const cache = await openCache();
      // Chrome 对缓存条目的 response.url 返回空串；真实 key 在 keys()（Request.url）里。
      // keys/matchAll 同为插入序 → 长度一致时按下标配对，并发写导致长度不齐时退回 response.url。
      const requests = await cache.keys();
      const responses = await cache.matchAll();
      const paired = requests.length === responses.length;
      sizes.clear();
      if (access.size === 0) restoreLru();
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        const raw = (paired ? requests[i]?.url : undefined) || response.url;
        const key = raw ? normalizeWebCacheKey(raw) : null;
        if (!key) continue;
        const declared = Number(response.headers.get(SIZE_HEADER) ?? response.headers.get('content-length'));
        sizes.set(key, Number.isFinite(declared) && declared > 0 ? declared : 0);
        if (!access.has(key)) {
          const stored = Number(response.headers.get(STORED_HEADER));
          access.set(key, Number.isFinite(stored) && stored > 0 ? stored : 1);
        }
      }
    } catch {
      /* 索引失败：缓存层降级为不可命中，播放仍走在线 */
    }
  })();
  return indexWarm;
}

function invalidateIndex() {
  indexWarm = null;
}

async function cacheMatch(key: string): Promise<Response | null> {
  if (!webCacheAvailable()) return null;
  try {
    const cache = await openCache();
    return (await cache.match(key)) ?? null;
  } catch {
    return null;
  }
}

function handleFor(entry: BlobEntry): WebAudioHandle {
  let done = false;
  return {
    url: entry.url,
    release: () => {
      if (done) return;
      done = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0 && entry.timer == null) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          try {
            URL.revokeObjectURL(entry.url);
          } catch {
            /* 忽略 */
          }
          releasedBlobUrls.push(entry.url);
          if (blobs.get(entry.key) === entry) blobs.delete(entry.key);
        }, BLOB_GRACE_MS);
        (entry.timer as unknown as { unref?: () => void })?.unref?.();
      }
    },
  };
}

/** 同步判断是否确定存在完整缓存条目：只信任 Blob 注册表与已装载索引；冷索引一律 false（调用方照常走在线路径）。 */
export function hasCachedAudioSync(rawUrl: string, options: PrepareOptions = {}): boolean {
  if (!webCacheAvailable()) return false;
  const key = normalizeWebCacheKey(rawUrl, options.base);
  if (!key) return false;
  if (blobs.has(key)) return true;
  return indexWarm !== null && sizes.has(key);
}

/** 预热内存索引（UI 挂载/空闲时调用）；失败静默。 */
export function primeWebAudioCacheIndex(): void {
  if (webCacheAvailable()) void ensureIndex().catch(NOOP);
}

/**
 * 仅当存在完整缓存条目时返回 Blob URL handle；未命中/不可用一律 null（调用方继续在线播放路径）。
 * 绝不触发下载 —— 下载只能由 prepareWebAudio 或用户明确选择发起。
 */
export async function acquireCachedAudio(rawUrl: string, options: PrepareOptions = {}): Promise<WebAudioHandle | null> {
  if (!webCacheAvailable()) return null;
  const key = normalizeWebCacheKey(rawUrl, options.base);
  if (!key) return null;
  const token = clearToken;
  const existing = blobs.get(key);
  if (existing && !existing.zombie) {
    if (existing.timer != null) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    existing.refs++;
    touch(key);
    return handleFor(existing);
  }
  try {
    const response = await cacheMatch(key);
    if (!response) {
      sizes.delete(key);
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (token !== clearToken) return null;
    const concurrent = blobs.get(key);
    if (concurrent && !concurrent.zombie) {
      if (concurrent.timer) { clearTimeout(concurrent.timer); concurrent.timer = null; }
      concurrent.refs++; touch(key); return handleFor(concurrent);
    }
    if (bytes.byteLength === 0) {
      // 空/坏条目（理论上不该出现）：顺手移除，避免卡住后续
      sizes.delete(key);
      void openCache().then((cache) => cache.delete(key)).catch(NOOP);
      return null;
    }
    const blob = new Blob([bytes], { type: response.headers.get('content-type') ?? 'audio/ogg' });
    const url = URL.createObjectURL(blob);
    const entry: BlobEntry = { url, key, refs: 1, timer: null, zombie: false };
    blobs.set(key, entry);
    sizes.set(key, bytes.byteLength);
    touch(key);
    return handleFor(entry);
  } catch {
    return null;
  }
}

/** Blob 播放报错等场景：删除该条缓存与内存 handle，让下次走网络。 */
export async function invalidateCachedAudio(rawUrl: string, options: PrepareOptions = {}): Promise<void> {
  const key = normalizeWebCacheKey(rawUrl, options.base);
  if (!key) return;
  const entry = blobs.get(key);
  if (entry) {
    entry.zombie = true;
    blobs.delete(key);
  }
  sizes.delete(key);
  access.delete(key);
  try {
    const cache = await openCache();
    await cache.delete(key);
  } catch {
    /* 忽略 */
  }
}

async function freeSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw Error('aborted');
  if (activeDownloads < WEB_AUDIO_MAX_PARALLEL_DOWNLOADS) {
    activeDownloads++;
    return releaseSlot;
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener('abort', abort);
      resolve(); // 槽位直接移交，activeDownloads 不重复计数
    };
    const abort = () => {
      const at = slotWaiters.indexOf(grant);
      if (at >= 0) slotWaiters.splice(at, 1);
      reject(Error('aborted'));
    };
    slotWaiters.push(grant);
    signal?.addEventListener('abort', abort, { once: true });
  });
  return releaseSlot;
}

function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) next();
  else activeDownloads = Math.max(0, activeDownloads - 1);
}

function isQuotaError(error: unknown): boolean {
  return (error as DOMException | undefined)?.name === 'QuotaExceededError' || (error as Error | undefined)?.name === 'QuotaExceededError';
}

/** 逐出最久未访问的一条（保护本次写入与在途 key）；没有可逐对象时返回 false。 */
async function evictOne(protectedKey: string): Promise<boolean> {
  const cache = await openCache();
  let victim: string | null = null;
  let victimTs = Infinity;
  for (const key of sizes.keys()) {
    if (key === protectedKey || inflight.has(key)) continue;
    const ts = access.get(key) ?? 0;
    if (ts < victimTs) {
      victimTs = ts;
      victim = key;
    }
  }
  if (victim == null) return false;
  const bytes = sizes.get(victim) ?? 0;
  sizes.delete(victim);
  access.delete(victim);
  const blobEntry = blobs.get(victim);
  if (blobEntry) {
    blobEntry.zombie = true;
    blobs.delete(victim);
  }
  try {
    await cache.delete(victim);
  } catch {
    /* 忽略 */
  }
  emit({ type: 'evicted', stableUrl: victim, bytes });
  return true;
}

function storeEntry(key: string, bytes: Uint8Array, contentType: string, token: number): Promise<boolean> {
  return serializeWrite(() => storeEntryLocked(key, bytes, contentType, token));
}
async function storeEntryLocked(key: string, bytes: Uint8Array, contentType: string, token: number): Promise<boolean> {
  const cache = await openCache();
  const build = () =>
    new Response(bytes.slice(), {
      status: 200,
      headers: { 'content-type': contentType, [SIZE_HEADER]: String(bytes.byteLength), [STORED_HEADER]: String(Date.now()) },
    });
  if (sizes.has(key)) sizes.delete(key); // 覆盖写：先卸掉旧尺寸再按新尺寸界内检查
  for (let attempt = 0; attempt < 8; attempt++) {
    if (token !== clearToken) return false; // clear 之后的在途写入一律作废，不复活
    if (bytes.byteLength > maxBytes()) return false;
    while (totalBytes() + bytes.byteLength > maxBytes()) if (!(await evictOne(key))) return false;
    try {
      await cache.put(key, build());
      if (token !== clearToken) { await cache.delete(key); return false; }
      sizes.set(key, bytes.byteLength);
      touch(key);
      persistLru();
      return true;
    } catch (error) {
      if (!isQuotaError(error)) return false;
      if (!(await evictOne(key))) return false; // 逐到只剩自己还不够 → 诚实放弃缓存
    }
  }
  return false;
}

function contentTypeName(response: Response): string | null {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type) return 'application/octet-stream'; // 缺 header：放行由 Content-Length/非空校验兜底（实测 local 后端始终带 audio/ogg）
  if (CACHEABLE_CT.test(type) || CACHEABLE_CT_EXACT.has(type)) return type;
  return null;
}

/** 真正下载并入库的一条完整管线；永不 throw、永不 reject。 */
async function download(key: string, controller: AbortController): Promise<boolean> {
  let release: (() => void) | null = null;
  try {
    release = await freeSlot(controller.signal);
    const token = clearToken;
    const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    let headerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(key, { signal: controller.signal, credentials: 'same-origin', redirect: 'follow' });
      if (headerTimer) {
        clearTimeout(headerTimer);
        headerTimer = null;
      }
      // 只认完整 200；opaque/no-cors 响应与 206（任何非 200）绝不入缓存。
      if (response.status !== 200 || controller.signal.aborted) throw Error('not-a-full-200');
      const rtype = response.type as string | undefined;
      if (rtype === 'opaque' || rtype === 'error') throw Error('opaque-response');
      const contentType = contentTypeName(response);
      if (!contentType) throw Error('bad-content-type');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > WEB_AUDIO_MAX_ENTRY_BYTES) throw Error('entry-too-large');
      let bytes: Uint8Array;
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
          try { while (true) {
            const {value, done} = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > Math.min(WEB_AUDIO_MAX_ENTRY_BYTES, maxBytes()) || controller.signal.aborted) throw Error('entry-too-large-or-aborted');
            chunks.push(value);
          } } catch (error) { await reader.cancel().catch(() => {}); throw error; }
          bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        } else bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw Error('body-read-failed');
      }
      if (bytes.byteLength === 0) throw Error('empty-body');
      if (Number.isFinite(declared) && declared > 0 && declared !== bytes.byteLength) throw Error('truncated-body');
      if (bytes.byteLength > WEB_AUDIO_MAX_ENTRY_BYTES) throw Error('entry-too-large');
      if (token !== clearToken) throw Error('cleared-midflight');
      const stored = await storeEntry(key, bytes, contentType, token);
      if (!stored) throw Error('storage-refused');
      emit({ type: 'cached', stableUrl: key, bytes: bytes.byteLength });
      return true;
    } finally {
      clearTimeout(timer);
      if (headerTimer) clearTimeout(headerTimer);
    }
  } catch (error) {
    emit({ type: 'failed', stableUrl: key, reason: (error as Error)?.message ?? 'download-failed' });
    return false;
  } finally {
    release?.();
  }
}

/** 同一 key 并发/重复调用去重：至多一条在途下载；任一等待方的 signal 中止该 key 的在途任务（换曲语义）。 */
function startDownload(key: string, options: PrepareOptions): Promise<boolean> {
  const existing = inflight.get(key);
  if (existing) {
    if (options.signal) {
      const abortNow = () => {
        existing.controller.abort();
        inflight.delete(key);
      };
      if (options.signal.aborted) return Promise.resolve(false);
      options.signal.addEventListener('abort', abortNow, { once: true });
    }
    return existing.promise;
  }
  const controller = new AbortController();
  const record: Inflight = { controller, promise: Promise.resolve(false) };
  inflight.set(key, record);
  if (options.signal) {
    if (options.signal.aborted) {
      inflight.delete(key);
      return Promise.resolve(false);
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  record.promise = download(key, controller).finally(() => {
    if (inflight.get(key) === record) inflight.delete(key);
  });
  return record.promise;
}

/**
 * 主入口：先查完整缓存，命中 → Blob URL；未命中 → 立即返回原地址（在线播放不等下载），
 * 并在后台开始完整下载，完成时经事件通道宣布可离线。下一次播放/重播即可直接命中。
 * 永不 reject。
 */
export async function prepareWebAudio(stableUrl: string, options: PrepareOptions = {}): Promise<WebAudioPrepared> {
  const degrade: WebAudioPrepared = { url: stableUrl, release: NOOP, cached: false, stableUrl: null, done: Promise.resolve(false) };
  if (!webCacheAvailable()) return degrade;
  const key = normalizeWebCacheKey(stableUrl, options.base);
  if (!key) return degrade;
  if (options.signal?.aborted) return { ...degrade, stableUrl: key };
  const hit = await acquireCachedAudio(key, options);
  if (options.signal?.aborted) { hit?.release(); return { ...degrade, stableUrl: key }; }
  if (hit) return { url: hit.url, release: hit.release, cached: true, stableUrl: key, done: Promise.resolve(true) };
  const done = startDownload(key, options);
  return { url: stableUrl, release: NOOP, cached: false, stableUrl: key, done };
}

export async function getWebCacheStats(): Promise<WebCacheStats> {
  const supported = webCacheAvailable();
  if (supported) await ensureIndex();
  return {
    bytes: totalBytes(),
    entries: sizes.size,
    maxBytes: maxBytes(),
    supported,
    downloading: inflight.size,
  };
}

/** 调整总上限（持久化，跨会话生效），并立即按新上限逐出超额条目。返回生效值。 */
export function setWebAudioCacheLimit(bytes: number): number {
  const next = clampLimit(bytes);
  memoryLimit = next;
  try {
    store()?.setItem(LIMIT_STORAGE_KEY, String(next));
  } catch {
    /* 存不下就用内存值（本次会话生效） */
  }
  void serializeWrite(async () => {
    await ensureIndex();
    while (totalBytes() > next && (await evictOne('__none__'))) {
      /* 逐出到界内 */
    }
  }).catch(NOOP);
  return next;
}

export function getWebAudioCacheLimit(): number {
  return maxBytes();
}

/** 清理本模块的全部音频缓存：中止在途、清索引与元数据；正在播放的 Blob URL 不撤销。 */
export async function clearWebAudioCache(): Promise<{ freedBytes: number; entries: number }> {
  clearToken++;
  const freedBytes = totalBytes();
  const entries = sizes.size;
  for (const record of inflight.values()) {
    try {
      record.controller.abort();
    } catch {
      /* 忽略 */
    }
  }
  inflight.clear();
  for (const entry of blobs.values()) entry.zombie = true; // 在途完成/已发出的 handle 之后都不得再命中
  blobs.clear();
  sizes.clear();
  access.clear();
  invalidateIndex();
  try {
    store()?.removeItem(LRU_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
  try {
    await cacheStorage()?.delete(WEB_AUDIO_CACHE_NAME);
  } catch {
    /* 忽略 */
  }
  emit({ type: 'cleared' });
  return { freedBytes, entries };
}

export function subscribeWebCacheEvents(listener: (event: WebCacheEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type WebAudioEntryState = 'cached' | 'downloading' | 'none' | 'unsupported';

/** UI 用：单条目的当前状态（cached=完整可离线；downloading=后台下载中）。 */
export async function getWebAudioEntryState(stableUrl: string, options: PrepareOptions = {}): Promise<WebAudioEntryState> {
  if (!webCacheAvailable()) return 'unsupported';
  const key = normalizeWebCacheKey(stableUrl, options.base);
  if (!key) return 'none';
  if (blobs.has(key)) return 'cached';
  if (inflight.has(key)) return 'downloading';
  await ensureIndex();
  if (sizes.has(key)) return 'cached';
  return (await cacheMatch(key)) ? 'cached' : 'none';
}

/** 测试专用：重置内存态（不动 CacheStorage），用于模拟页面重载后的冷启动命中。 */
export function __resetWebAudioCacheStateForTest(): void {
  memoryLimit = null;
  clearToken++;
  for (const record of inflight.values()) {
    try {
      record.controller.abort();
    } catch {
      /* 忽略 */
    }
  }
  inflight.clear();
  for (const entry of blobs.values()) entry.zombie = true;
  blobs.clear();
  sizes.clear();
  access.clear();
  invalidateIndex();
  activeDownloads = 0;
  while (slotWaiters.length) slotWaiters.shift()!();
}

/** 测试专用：读取 blob revoke 记录与内部名。 */
export function __webCacheInternalsForTest() {
  return { name: WEB_AUDIO_CACHE_NAME, revoked: releasedBlobUrls, clearRevoked: () => (releasedBlobUrls = []) };
}
