/**
 * catalog-offline — 最后完整已验证目录的离线持久快照（Web + App 冷启动）。
 *
 * 设计契约（详见 docs/catalog-offline.md）：
 * - 保存：fetchIndex/loadMonth 成功提交后才持久化；先写不可变 revision 数据（manifest、月块），
 *   全部成功后才更新指针；任何一步失败，旧指针与旧快照完好（「失败旧快照完好」）。
 * - 恢复：离线冷启动用 loadOfflineSnapshot 读出与在线完全一致的结构（validateManifest/validateMonth
 *   复验）；损坏或 revision 不吻合的条目不 hydrate，明确标记，不假装新鲜。
 * - 隔离：全部键按后端 origin + base path（baseKey）分开；A 后端的快照绝不会 hydrate 进 B 后端；
 *   reset/切后端不删除任何快照，只有用户显式 clear 才删。
 * - 有界：最多 limits.maxMonths 个月块（按保存时间 LRU 淘汰，与 MAX_CACHED_MONTHS 口径一致）；
 *   其中「含完整音频缓存」的月份在淘汰中优先保留（owner 裁定 ④「音频优先」，仍在同一上限内）；
 *   月块字节上限 + 条数上限（超限直接跳过、不做超大 stringify）；总额 = 存储预算。
 *   quota/失败只影响快照，绝不阻塞播放与目录浏览。
 * - 存储：统一注入式 KV。web 优先 CacheStorage(caches)，Capacitor 优先 localStorage（有界 JSON 分片）,
 *   两者同一键布局；Capacitor 的 AnyunCache 桥（warm start）与 serviceworker（shell）各自独立，
 *   离线快照完全不依赖桥的网络回退。测试注入 createMemoryKv 模拟进程重启。
 */
import { validateManifest, validateMonth } from './catalog-schema.js';

export interface OfflineKv {
  kind(): string;
  budgetBytes(): number;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export interface OfflineMonthEntry { id: string; revision: string; key: string; available: boolean; count: number; startAt: number; endAt: number }
export interface OfflineManifest { schemaVersion: 2; timezone: string; generatedAt: number; revision: string; months: OfflineMonthEntry[]; queryMonthLimit?: number }
export interface OfflineRuntime { native?: boolean; expectedRevision?: string; /** 含完整音频缓存的月份（owner 裁定 ④「音频优先」）：快照淘汰时这些月份优先保留，月度上限不变。 */ protectedMonths?: string[] }

export type OfflineSaveStatus = 'saved' | 'no-storage' | 'stale' | 'invalid' | 'too-large' | 'quota' | 'unavailable';
export interface OfflineSaveResult { ok: boolean; status: OfflineSaveStatus; savedAt?: number; error?: string }

export type OfflineSnapshot =
  | { status: 'empty' }
  | { status: 'corrupt'; reason: string }
  | { status: 'snapshot'; revision: string; savedAt: number; manifest: OfflineManifest; months: Record<string, { id: string; revision: string; audios: any[] }>; notice?: string };

const KEY_PREFIX = 'aof|';
const POINTER_VERSION = 1;
const CACHE_NAME = 'anyun-catalog-offline-v1';
const CACHE_SYNTHETIC_ORIGIN = 'https://offline.catalog.invalid'; // 保留域，仅合成 URL，不是真实后端
const MONTH_BYTES_LIMIT = 1_572_864; // 单月块序列化上限 1.5MB：超过直接跳过，主线程不做超大 stringify
const MONTH_RECORDINGS_LIMIT = 1500; // 单月块条数上限：序列化前的粗过滤

const limits = { maxMonths: 3 };
export function configureOfflineLimits(next: { maxMonths?: number } = {}): void {
  if (Number.isInteger(next.maxMonths) && (next.maxMonths as number) > 0) limits.maxMonths = next.maxMonths as number;
}

function bytesOf(text: string): number {
  try { return new TextEncoder().encode(text).length; } catch { return text.length * 2; }
}

function isQuotaError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | undefined;
  return /quota/i.test(String(e?.name ?? '') + String(e?.message ?? ''));
}

/** 后端 origin + base path → 存储 baseKey；''（同源）与非法值都有确定映射。 */
export function offlineBaseKey(rawBase?: string | null): string {
  const base = String(rawBase ?? '').trim();
  if (!base) return 'same-origin';
  try { const u = new URL(base); if (u.origin && u.origin !== 'null') return (u.origin + u.pathname.replace(/\/+$/, '')).replace(/\|/g, '%7C'); } catch { /* 落入原样转义 */ }
  return ('raw:' + base).replace(/\|/g, '%7C');
}

const pKey = (baseKey: string) => KEY_PREFIX + 'p|' + baseKey;
const mKey = (baseKey: string, revision: string) => KEY_PREFIX + 'm|' + baseKey + '|' + revision.replace(/\|/g, '%7C');
const MKey = (baseKey: string, revision: string, id: string) => KEY_PREFIX + 'M|' + baseKey + '|' + revision.replace(/\|/g, '%7C') + '|' + id;

// ———— KV 实现 ————

/** 测试注入用内存 KV：模拟「进程/模块重启后仍在」的持久层，可控预算与写失败。 */
export function createMemoryKv(options: { kind?: string; budgetBytes?: number } = {}): OfflineKv & { entries(): Map<string, string>; failNextWith(mode: 'quota' | 'error'): void; setBudget(n: number): void } {
  const data = new Map<string, string>();
  let failures: string[] = [];
  let budget = options.budgetBytes ?? Infinity;
  const kv: OfflineKv & { entries(): Map<string, string>; failNextWith(mode: 'quota' | 'error'): void; setBudget(n: number): void } = {
    entries: () => new Map(data),
    kind: () => options.kind ?? 'memory',
    budgetBytes: () => budget,
    setBudget: n => { budget = n; },
    failNextWith: mode => { failures.push(mode); },
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) {
      const mode = failures.shift();
      if (mode) { const e = Error(mode === 'quota' ? 'QuotaExceededError' : 'storage write failed'); e.name = mode === 'quota' ? 'QuotaExceededError' : 'IOError'; throw e; }
      let total = 0;
      for (const [k, v] of data) if (k !== key) total += bytesOf(v);
      if (total + bytesOf(value) > budget) { const e = Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      data.set(key, value);
    },
    async delete(key) { data.delete(key); },
    async keys(prefix) { return [...data.keys()].filter(k => k.startsWith(prefix)); },
  };
  return kv;
}

class LocalStorageKv implements OfflineKv {
  private budget: number;
  constructor(budgetBytes = 1_048_576) { this.budget = budgetBytes; } // 小型有界 fallback：默认 1MB
  kind() { return 'localstorage'; }
  budgetBytes() { return this.budget; }
  private ls(): Storage { return (globalThis as any).localStorage; }
  async get(key: string) { try { return this.ls().getItem(key); } catch { return null; } }
  async set(key: string, value: string) { this.ls().setItem(key, value); } // 超浏览器配额由 ls 抛 QuotaExceededError，调用方分类处理
  async delete(key: string) { try { this.ls().removeItem(key); } catch { /* 尽力而为 */ } }
  async keys(prefix: string) { try { const out: string[] = []; for (let i = 0; i < this.ls().length; i++) { const k = this.ls().key(i); if (k && k.startsWith(prefix)) out.push(k); } return out; } catch { return []; } }
}

class CacheStorageKv implements OfflineKv {
  private budget: number;
  constructor(budgetBytes = 4_194_304) { this.budget = budgetBytes; } // web 主通道：4MB
  kind() { return 'cachestorage'; }
  budgetBytes() { return this.budget; }
  private async cache(): Promise<any> { return await (globalThis as any).caches.open(CACHE_NAME); }
  private url(key: string) { return CACHE_SYNTHETIC_ORIGIN + '/' + encodeURIComponent(key); }
  private keyOf(url: string) { try { return decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return ''; } }
  async get(key: string) { try { const hit = await (await this.cache()).match(this.url(key)); return hit ? await hit.text() : null; } catch { return null; } }
  async set(key: string, value: string) { const c = await this.cache(); await c.put(new Request(this.url(key)), new Response(value)); }
  async delete(key: string) { try { const c = await this.cache(); await c.delete(this.url(key)); } catch { /* 尽力而为 */ } }
  async keys(prefix: string) { try { const c = await this.cache(); const list = await c.keys(); return list.map((r: any) => this.keyOf(String(r.url))).filter((k: string) => k.startsWith(prefix)); } catch { return []; } }
}

let injectedKv: OfflineKv | null = null;
let localKv: LocalStorageKv | null = null;
let cacheKv: CacheStorageKv | null = null;
export function configureOfflineKv(kv: OfflineKv | null): void { injectedKv = kv; }
export function resolveOfflineKv(runtime: OfflineRuntime = {}): OfflineKv | null {
  if (injectedKv) return injectedKv;
  const hasCaches = typeof (globalThis as any).caches?.open === 'function';
  const hasLocalStorage = typeof (globalThis as any).localStorage?.setItem === 'function';
  // Capacitor 环境 CacheStorage 不保证可用且易被清理：localStorage（有界 JSON 分片）优先。
  if (runtime.native && hasLocalStorage) return (localKv ??= new LocalStorageKv());
  if (hasCaches) return (cacheKv ??= new CacheStorageKv());
  if (hasLocalStorage) return (localKv ??= new LocalStorageKv());
  return null;
}
export function offlineStorageInfo(runtime: OfflineRuntime = {}): { kind: string; budgetBytes: number; maxMonths: number } {
  const kv = resolveOfflineKv(runtime);
  return { kind: kv?.kind() ?? 'none', budgetBytes: kv?.budgetBytes() ?? 0, maxMonths: limits.maxMonths };
}

// ———— 写队列（串行化，避免 LS 读改写的丢更新；flush 供测试与交付点使用） ————

let queueTail: Promise<void> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queueTail.then(task);
  queueTail = next.then(() => undefined, () => undefined);
  return next;
}
export function flushOfflineWrites(): Promise<void> { return queueTail; }

// ———— 指针/记录 ————

interface PointerRecord { v: number; revision: string; savedAt: number; months: Record<string, number> }
type PointerRead = { state: 'missing' } | { state: 'corrupt' } | { state: 'ok'; pointer: PointerRecord };

async function readPointer(kv: OfflineKv, baseKey: string): Promise<PointerRead> {
  const raw = await kv.get(pKey(baseKey));
  if (raw == null) return { state: 'missing' };
  try {
    const p = JSON.parse(raw);
    if (p && p.v === POINTER_VERSION && typeof p.revision === 'string' && p.revision && Number.isFinite(p.savedAt))
      return { state: 'ok', pointer: { v: POINTER_VERSION, revision: p.revision, savedAt: p.savedAt, months: p.months && typeof p.months === 'object' ? p.months : {} } };
  } catch { /* 落入 corrupt */ }
  return { state: 'corrupt' };
}

async function snapshotBytes(kv: OfflineKv): Promise<number> {
  let total = 0;
  for (const key of await kv.keys(KEY_PREFIX)) total += bytesOf((await kv.get(key)) ?? '');
  return total;
}

async function fitsBudget(kv: OfflineKv, key: string, valueBytes: number): Promise<boolean> {
  const existing = await kv.get(key);
  const projected = (await snapshotBytes(kv)) - (existing ? bytesOf(existing) : 0) + valueBytes;
  return projected <= kv.budgetBytes();
}

function classifyError(error: unknown): OfflineSaveResult {
  const e = error as { name?: string; message?: string };
  const status: OfflineSaveStatus = isQuotaError(error) ? 'quota' : 'unavailable';
  return { ok: false, status, error: String(e?.message ?? error) };
}

async function dropBaseKeys(kv: OfflineKv, baseKey: string): Promise<number> {
  let removed = 0;
  for (const key of await kv.keys(KEY_PREFIX)) {
    const parts = key.split('|');
    if (parts[2] === baseKey) { await kv.delete(key); removed++; }
  }
  return removed;
}

/** 只保留当前 revision 的不可变快照数据；旧 revision 文档尽力清理（有界，不留垃圾）。 */
async function pruneOldRevisions(kv: OfflineKv, baseKey: string, revision: string): Promise<void> {
  try {
    for (const key of await kv.keys(KEY_PREFIX)) {
      const parts = key.split('|');
      if (parts.length < 3 || parts[2] !== baseKey || (parts[1] !== 'm' && parts[1] !== 'M')) continue;
      if (parts[3] === revision) continue;
      await kv.delete(key);
    }
  } catch { /* 清理失败不影响新快照 */ }
}

// ———— 保存（network-first 提交之后调用；先数据、后指针） ————

/** Commit a validated revision with all loaded months before switching its pointer. */
export function saveCatalogSnapshot(rawBase: string | null | undefined, manifest: OfflineManifest, loaded: Record<string, unknown[]>, runtime: OfflineRuntime = {}): Promise<OfflineSaveResult> {
  return enqueue(async () => {
    const kv = resolveOfflineKv(runtime);
    if (!kv) return { ok: false, status: 'no-storage' };
    try { validateManifest(manifest); } catch { return { ok: false, status: 'invalid' }; }
    const base = offlineBaseKey(rawBase);
    const staged = new Map<string, string>();
    const newlyWritten: string[] = [];
    let committed = false;
    try {
      const previous = await readPointer(kv, base);
      if (runtime.expectedRevision && (previous.state !== 'ok' || previous.pointer.revision !== runtime.expectedRevision)) return { ok: false, status: 'stale' };
      const months: Record<string, number> = previous.state === 'ok' && previous.pointer.revision === manifest.revision ? { ...previous.pointer.months } : {};
      staged.set(mKey(base, manifest.revision), JSON.stringify(manifest));
      for (const [id, audios] of Object.entries(loaded).slice(-limits.maxMonths)) {
        const entry = manifest.months.find(e => e.id === id && e.available);
        if (!entry) continue;
        if (audios.length > MONTH_RECORDINGS_LIMIT) return { ok: false, status: 'too-large' };
        const doc = { schemaVersion: 2, id, revision: entry.revision, audios };
        validateMonth(doc, entry);
        const value = JSON.stringify(doc);
        if (bytesOf(value) > MONTH_BYTES_LIMIT) return { ok: false, status: 'too-large' };
        staged.set(MKey(base, manifest.revision, id), value);
        months[id] = Date.now();
      }
      // owner ④（音频优先）：月份上限（maxMonths）内先保留「有完整音频缓存」的月份——
      // 音频已缓存的月份丢掉目录块，会让这份音频失去离线可用信息。上限本身不变（提升上限属延期项）。
      const protectedIds = new Set(runtime.protectedMonths ?? []);
      const protectedRank = (id: string) => (protectedIds.has(id) ? 1 : 0);
      const selected = Object.keys(months).filter(id => manifest.months.some(e => e.id === id && e.available)).sort((a,b) => protectedRank(b) - protectedRank(a) || months[b]-months[a] || Number(b in loaded)-Number(a in loaded)).slice(0, limits.maxMonths);
      const savedAt = Date.now();
      const pointer = JSON.stringify({ v: POINTER_VERSION, revision: manifest.revision, savedAt, months: Object.fromEntries(selected.map(id => [id, months[id]])) });
      const writes = new Map(staged); writes.set(pKey(base), pointer);
      let projected = await snapshotBytes(kv);
      for (const [key, value] of writes) projected += bytesOf(value) - bytesOf((await kv.get(key)) ?? '');
      if (projected > kv.budgetBytes()) return { ok: false, status: 'quota' };
      for (const [key, value] of staged) {
        if (await kv.get(key) == null) newlyWritten.push(key);
        await kv.set(key, value);
      }
      await kv.set(pKey(base), pointer);
      committed = true;
      const keep = new Set([pKey(base), mKey(base, manifest.revision), ...selected.map(id => MKey(base, manifest.revision, id))]);
      for (const key of await kv.keys(KEY_PREFIX)) if (key.split('|')[2] === base && !keep.has(key)) await kv.delete(key).catch(() => {});
      return { ok: true, status: 'saved', savedAt };
    } catch (error) {
      if (!committed) for (const key of newlyWritten) await kv.delete(key).catch(() => {});
      return classifyError(error);
    }
  });
}

export function saveManifestSnapshot(rawBase: string | null | undefined, manifest: OfflineManifest, runtime: OfflineRuntime = {}): Promise<OfflineSaveResult> {
  return saveCatalogSnapshot(rawBase, manifest, {}, runtime);
}

export async function saveMonthSnapshot(rawBase: string | null | undefined, manifest: OfflineManifest | null, monthId: string, audios: unknown[], runtime: OfflineRuntime = {}): Promise<OfflineSaveResult> {
  const kv = resolveOfflineKv(runtime);
  if (!kv) return { ok: false, status: 'no-storage' };
  const entry = manifest?.months?.find(e => e.id === monthId);
  if (!entry?.available || !Array.isArray(audios)) return { ok: false, status: 'stale' };
  if (entry.count > MONTH_RECORDINGS_LIMIT || audios.length > MONTH_RECORDINGS_LIMIT) return { ok: false, status: 'too-large' };
  return saveCatalogSnapshot(rawBase, manifest!, { [monthId]: audios }, { ...runtime, expectedRevision: manifest!.revision });
}

// ———— 恢复（离线冷启动） ————

export function loadOfflineSnapshot(rawBase: string | null | undefined, runtime: OfflineRuntime = {}): Promise<OfflineSnapshot> {
  return enqueue(async () => {
    const kv = resolveOfflineKv(runtime);
    if (!kv) return { status: 'empty' };
    const baseKey = offlineBaseKey(rawBase);
    const read = await readPointer(kv, baseKey);
    if (read.state === 'missing') return { status: 'empty' };
    if (read.state === 'corrupt') { await dropBaseKeys(kv, baseKey); return { status: 'corrupt', reason: 'pointer' }; }
    const pointer = read.pointer;
    const rawManifest = await kv.get(mKey(baseKey, pointer.revision));
    if (rawManifest == null) { await dropBaseKeys(kv, baseKey); return { status: 'corrupt', reason: 'manifest-missing' }; }
    let manifest: OfflineManifest;
    try { manifest = validateManifest(JSON.parse(rawManifest)) as OfflineManifest; } catch { await dropBaseKeys(kv, baseKey); return { status: 'corrupt', reason: 'manifest' }; }
    if (manifest.revision !== pointer.revision) { await dropBaseKeys(kv, baseKey); return { status: 'corrupt', reason: 'revision-mismatch' }; }
    const months: Record<string, { id: string; revision: string; audios: any[] }> = {};
    let dropped = 0;
    for (const id of Object.keys(pointer.months).sort((a,b)=>pointer.months[b]-pointer.months[a]).slice(0,limits.maxMonths)) {
      const entry = manifest.months.find(e => e.id === id);
      if (!entry?.available) { dropped++; await kv.delete(MKey(baseKey, pointer.revision, id)).catch(() => undefined); continue; }
      const raw = await kv.get(MKey(baseKey, pointer.revision, id));
      if (raw == null) { dropped++; continue; }
      try {
        const doc = validateMonth(JSON.parse(raw), entry) as { id: string; revision: string; audios: any[] };
        months[id] = { id, revision: entry.revision, audios: doc.audios };
      } catch {
        dropped++;
        await kv.delete(MKey(baseKey, pointer.revision, id)).catch(() => undefined);
      }
    }
    return { status: 'snapshot', revision: pointer.revision, savedAt: pointer.savedAt, manifest, months, notice: dropped ? `已跳过 ${dropped} 个损坏或不吻合的离线月份` : '' };
  });
}

// ———— 网络失败降级供给（仅供 catalogFetch 在 TypeError 网络层失败时调用） ————

let lastServe: { baseKey: string; kind: 'manifest' | 'month'; at: number } | null = null;

export async function serveOfflineJson(rawBase: string | null | undefined, target: string, signal?: AbortSignal | null, runtime: OfflineRuntime = {}): Promise<Response | null> {
  if (signal?.aborted || typeof Response !== 'function') return null;
  const kv = resolveOfflineKv(runtime);
  if (!kv) return null;
  const baseKey = offlineBaseKey(rawBase);
  const t = String(target);
  try {
    const read = await readPointer(kv, baseKey);
    if (read.state !== 'ok') return null;
    const pointer = read.pointer;
    if (t.startsWith('/api/catalog')) {
      const raw = await kv.get(mKey(baseKey, pointer.revision));
      if (raw == null) return null;
      lastServe = { baseKey, kind: 'manifest', at: Date.now() };
      return new Response(raw, { status: 200, headers: { 'content-type': 'application/json', 'x-anyun-cache': 'offline' } });
    }
    if (t.startsWith('/api/month/')) {
      const u = new URL(t, CACHE_SYNTHETIC_ORIGIN);
      const id = decodeURIComponent(u.pathname.slice('/api/month/'.length));
      const release = u.searchParams.get('release');
      if (!id || !release || release !== pointer.revision) return null;
      const raw = await kv.get(MKey(baseKey, release, id));
      if (raw == null) return null;
      lastServe = { baseKey, kind: 'month', at: Date.now() };
      return new Response(raw, { status: 200, headers: { 'content-type': 'application/json', 'x-anyun-cache': 'offline' } });
    }
  } catch { return null; }
  return null;
}

/** fetchIndex 消费本次操作内的离线供给标记（generation 时窗由调用方 startedAt 界定）。 */
export function takeOfflineServe(rawBase: string | null | undefined, sinceAt: number): 'manifest' | 'month' | null {
  if (lastServe && lastServe.baseKey === offlineBaseKey(rawBase) && lastServe.at >= sinceAt) {
    const kind = lastServe.kind;
    lastServe = null;
    return kind;
  }
  return null;
}

// ———— 清除（只有用户显式操作才到这里；reset/切后端不会调用） ————

export function clearOfflineSnapshots(rawBase: string | null | undefined, runtime: OfflineRuntime = {}): Promise<number> {
  return enqueue(async () => {
    const kv = resolveOfflineKv(runtime);
    if (!kv) return 0;
    lastServe = null;
    if (rawBase === null) {
      let removed = 0;
      for (const key of await kv.keys(KEY_PREFIX)) { await kv.delete(key); removed++; }
      return removed;
    }
    return await dropBaseKeys(kv, offlineBaseKey(rawBase));
  });
}
