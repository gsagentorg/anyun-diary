import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 原生缓存桥（iOS）。网页层只做「URL 适配 + 调用」，不实现任何缓存逻辑：
 * 音频/索引的缓存、SWR、LRU 全在 Swift 侧（见 docs/ios-audio-cache.md）。
 *
 * - `nativeAudioSrc()` 把音频地址换成 `anyun-cache://media?u=...`，由 WKURLSchemeHandler 提供；
 *   原生不可用时原样返回，web 行为与从前完全一致。
 * - `nativeFetchJSON()` 走插件方法取索引（缓存 + 宽松 revalidate）；web 由调用方回退到 fetch。
 * - 其余方法服务于设置/调试入口（统计、清空、调整策略）。
 */

export const NATIVE_CACHE_SCHEME = 'anyun-cache';
export const NATIVE_CACHE_HOST = 'media';
export const NATIVE_CACHE_PLUGIN = 'AnyunCache';
export const NATIVE_CACHE_METHODS = ['configure', 'stats', 'clear', 'setPolicy', 'fetchJSON'] as const;

export type CacheScope = 'all' | 'media' | 'json';
export type CacheSource = 'cache' | 'network' | 'stale';

export interface CachePolicy {
  maxBytes: number;
  maxEntries: number;
  mediaRevalidateSeconds: number;
  jsonStaleSeconds: number;
}

/** 与 Swift `AnyunCacheConstants` 保持一致（静态断言在 scripts/test-ios-cache.mjs）。 */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  maxBytes: 536_870_912,
  maxEntries: 4000,
  mediaRevalidateSeconds: 604_800,
  jsonStaleSeconds: 60,
};

/** [min, max]，与 Swift 的夹取范围一致。 */
export const CACHE_POLICY_LIMITS: Record<keyof CachePolicy, readonly [number, number]> = {
  maxBytes: [16_777_216, 4_294_967_296],
  maxEntries: [64, 20_000],
  mediaRevalidateSeconds: [3_600, 2_592_000],
  jsonStaleSeconds: [5, 3_600],
};

export interface CacheStats {
  bytes: number;
  entries: number;
  mediaEntries: number;
  jsonEntries: number;
  maxBytes: number;
  cacheDir?: string;
}

export interface FetchJSONResult<T = unknown> {
  data: T;
  source: CacheSource;
  ageSeconds?: number;
  offline?: boolean;
}

/** 原生插件的最小契约面；测试用假实现替代。 */
export interface NativeCacheApi {
  configure?(options: { policy?: Partial<CachePolicy> }): Promise<{ policy: CachePolicy }>;
  stats(): Promise<CacheStats>;
  clear(options: { scope?: CacheScope }): Promise<{ freedBytes: number; entries: number }>;
  setPolicy(options: { policy: Partial<CachePolicy> }): Promise<{ policy: CachePolicy }>;
  fetchJSON(options: { url: string; force?: boolean }): Promise<FetchJSONResult>;
}

let probed = false;
let cachedApi: NativeCacheApi | null = null;

/** 原生壳内且插件已注册时返回插件句柄；其余情况（含 web）返回 null。 */
export function nativeCacheApi(): NativeCacheApi | null {
  if (cachedApi) return cachedApi;
  if (probed) return null;
  probed = true;
  try {
    if (!Capacitor.isNativePlatform()) return null;
    if (!Capacitor.isPluginAvailable(NATIVE_CACHE_PLUGIN)) return null;
    cachedApi = registerPlugin<NativeCacheApi>(NATIVE_CACHE_PLUGIN);
  } catch {
    cachedApi = null;
  }
  return cachedApi;
}

export function nativeCacheAvailable(): boolean {
  return nativeCacheApi() !== null;
}

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 未给字段沿用 base；非法值回落 base；结果一定落在 CACHE_POLICY_LIMITS 内。 */
export function clampCachePolicy(input: Partial<CachePolicy> | null | undefined, base: CachePolicy = DEFAULT_CACHE_POLICY): CachePolicy {
  const source = input ?? {};
  return {
    maxBytes: clampNumber(source.maxBytes, CACHE_POLICY_LIMITS.maxBytes, base.maxBytes),
    maxEntries: clampNumber(source.maxEntries, CACHE_POLICY_LIMITS.maxEntries, base.maxEntries),
    mediaRevalidateSeconds: clampNumber(
      source.mediaRevalidateSeconds,
      CACHE_POLICY_LIMITS.mediaRevalidateSeconds,
      base.mediaRevalidateSeconds,
    ),
    jsonStaleSeconds: clampNumber(source.jsonStaleSeconds, CACHE_POLICY_LIMITS.jsonStaleSeconds, base.jsonStaleSeconds),
  };
}

/** 原始 https 地址 → 原生 scheme 地址；非 https/非法地址返回 null（web 侧保持原样）。 */
export function buildCacheAudioURL(remote: string): string | null {
  if (typeof remote !== 'string' || !remote) return null;
  let target: URL;
  try {
    target = new URL(remote);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') return null;
  return `${NATIVE_CACHE_SCHEME}://${NATIVE_CACHE_HOST}?u=${encodeURIComponent(target.href)}`;
}

/** 反向解析（诊断/测试用）；不是本 scheme 或目标非 https 时返回 null。 */
export function parseCacheAudioURL(cacheURL: string): string | null {
  if (typeof cacheURL !== 'string' || !cacheURL) return null;
  let parsed: URL;
  try {
    parsed = new URL(cacheURL);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${NATIVE_CACHE_SCHEME}:` || parsed.hostname !== NATIVE_CACHE_HOST) return null;
  const raw = parsed.searchParams.get('u');
  if (!raw) return null;
  try {
    const target = new URL(raw);
    return target.protocol === 'https:' ? target.href : null;
  } catch {
    return null;
  }
}

export function isCacheAudioURL(url: string): boolean {
  return parseCacheAudioURL(url) !== null;
}

/**
 * `<audio src>` 的最终地址：原生可用 → scheme 地址（由原生缓存提供，命中即刻播放）；
 * 否则原样返回。永远不抛异常：播放不能因为缓存层出问题而中断。
 */
export function nativeAudioSrc(url: string, api: NativeCacheApi | null = nativeCacheApi()): string {
  if (!api || !url) return url;
  return buildCacheAudioURL(url) ?? url;
}

/**
 * 索引拉取：原生走带缓存的插件方法；web/无插件返回 null，由调用方回退到普通 fetch。
 * `force` 跳过新鲜窗口（UI「重试」用）。
 */
export async function nativeFetchJSON<T = unknown>(
  url: string,
  options: { force?: boolean; api?: NativeCacheApi | null } = {},
): Promise<FetchJSONResult<T> | null> {
  const api = options.api === undefined ? nativeCacheApi() : options.api;
  if (!api) return null;
  const result = await api.fetchJSON({ url, ...(options.force ? { force: true } : {}) });
  return { ...result, data: result.data as T };
}

export async function nativeCacheStats(api: NativeCacheApi | null = nativeCacheApi()): Promise<CacheStats | null> {
  if (!api) return null;
  try {
    return await api.stats();
  } catch {
    return null;
  }
}

export async function clearNativeCache(
  scope: CacheScope = 'all',
  api: NativeCacheApi | null = nativeCacheApi(),
): Promise<{ freedBytes: number; entries: number } | null> {
  if (!api) return null;
  try {
    return await api.clear({ scope });
  } catch {
    return null;
  }
}

export async function setNativeCachePolicy(
  policy: Partial<CachePolicy>,
  api: NativeCacheApi | null = nativeCacheApi(),
): Promise<CachePolicy | null> {
  if (!api) return null;
  try {
    const result = await api.setPolicy({ policy: clampCachePolicy(policy) });
    return result?.policy ? clampCachePolicy(result.policy) : clampCachePolicy(policy);
  } catch {
    return null;
  }
}

/** 人类可读的缓存占用。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 播放失败时的说明：离线且未缓存要说得明确，不假装还在加载。
 */
export function audioFailureText(online: boolean): string {
  return online
    ? '音频加载失败：网络或数据源异常，可重试'
    : '离线，且本曲未缓存，无法播放';
}