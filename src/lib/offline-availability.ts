import { Capacitor } from '@capacitor/core';
import { nativeMediaStatus, subscribeNativeCacheChanges } from './native-cache';
import { getWebAudioEntryState, normalizeWebCacheKey, subscribeWebCacheEvents, webCacheAvailable, WEB_AUDIO_CACHE_NAME, WEB_AUDIO_MAX_ENTRY_BYTES } from './web-audio-cache';

export type OfflineAvailability = 'cached' | 'missing' | 'unknown';
export interface AvailabilitySnapshot {
  online: boolean;
  statuses: Record<string, OfflineAvailability>;
}
export interface AvailabilityOptions {
  query: (urls: string[]) => Promise<Record<string, OfflineAvailability>>;
  online: () => boolean;
  listenNetwork?: (changed: () => void) => () => void;
  listenCache?: (changed: () => void) => () => void;
  pollMs?: number;
  timeoutMs?: number;
}
export const AVAILABILITY_BATCH_SIZE = 100;
export const WEB_STATUS_CONCURRENCY = 8;

/** The cache writer commits a new complete 200 Response with these headers only
 * after validating all downloaded bytes. Mere Cache.match existence (or a warm
 * sizes index) does not prove completeness. No audio body is read for row hints. */
export function isCompleteWebCacheResponse(response: Response): boolean {
  if (response.status !== 200 || response.type === 'opaque' || response.type === 'error' || response.headers.has('content-range')) return false;
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/') && !type.startsWith('video/') && !['application/ogg', 'application/octet-stream', 'application/mp4', 'application/x-wav'].includes(type)) return false;
  const size = Number(response.headers.get('x-anyun-bytes'));
  const stored = Number(response.headers.get('x-anyun-stored-at'));
  if (!Number.isSafeInteger(size) || size <= 0 || size > WEB_AUDIO_MAX_ENTRY_BYTES || !Number.isFinite(stored) || stored <= 0 || response.body === null) return false;
  const length = response.headers.get('content-length');
  return length === null || Number(length) === size;
}

/** Existing state query plus a fresh response/header check: no stale sizes-only
 * positive, no downloads, no body reads, no per-render full file scanning. */
export async function webMediaStatus(urls: string[]): Promise<Record<string, OfflineAvailability>> {
  const result: Record<string, OfflineAvailability> = Object.fromEntries(urls.map(url => [url, 'unknown']));
  let cache: Cache;
  try {
    if (!webCacheAvailable()) return result;
    cache = await caches.open(WEB_AUDIO_CACHE_NAME);
  } catch { return result; }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WEB_STATUS_CONCURRENCY, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const key = normalizeWebCacheKey(url);
      if (!key) continue;
      try {
        const state = await getWebAudioEntryState(url);
        if (state === 'unsupported') continue;
        const response = await cache.match(key);
        if (response && isCompleteWebCacheResponse(response)) result[url] = 'cached';
        else if (!response && state !== 'cached') result[url] = 'missing';
        // A stale cached index or an untrusted response is unknown: the public
        // core API cannot distinguish a live complete Blob from a stale size.
      } catch { /* Deliberately not a negative verdict. */ }
    }
  }));
  return result;
}

function browserOptions(): AvailabilityOptions {
  const native = typeof window !== 'undefined' && Capacitor.isNativePlatform();
  return {
    query: native ? urls => nativeMediaStatus(urls) : webMediaStatus,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    listenNetwork: changed => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('online', changed);
      window.addEventListener('offline', changed);
      window.addEventListener('focus', changed);
      return () => {
        window.removeEventListener('online', changed);
        window.removeEventListener('offline', changed);
        window.removeEventListener('focus', changed);
      };
    },
    listenCache: native ? subscribeNativeCacheChanges : changed => subscribeWebCacheEvents(() => changed()),
    // Native contract has no push event: observe prefetch/OS eviction on a bounded
    // visible-list interval. Local clear/policy changes invalidate immediately.
    pollMs: native ? 15_000 : 0,
  };
}

/** Lazy Svelte store; no IO online, deduplicated targets, one serial batch.
 * A timed-out bridge remains owned until settlement: it cannot cause fan-out. */
export function createOfflineAvailability(options: AvailabilityOptions = browserOptions()) {
  let snapshot: AvailabilitySnapshot = { online: true, statuses: {} };
  let urls: string[] = [], context = '';
  let epoch = 0, running = false, pending = false;
  const subscribers = new Set<(value: AvailabilitySnapshot) => void>();
  let stopNetwork: (() => void) | undefined, stopCache: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => { for (const subscriber of subscribers) subscriber(snapshot); };
  const owned = (token: number) => token === epoch && subscribers.size > 0 && !snapshot.online;

  function invalidate() {
    epoch++;
    snapshot = { online: options.online(), statuses: {} };
    pending = true;
    publish();
    void run();
  }
  async function run() {
    if (running || !pending || !subscribers.size) return;
    pending = false;
    if (snapshot.online || !urls.length) return;
    running = true;
    const token = epoch, targets = [...urls];
    try {
      for (let offset = 0; offset < targets.length && owned(token); offset += AVAILABILITY_BATCH_SIZE) {
        const batch = targets.slice(offset, offset + AVAILABILITY_BATCH_SIZE);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const task = Promise.resolve().then(() => options.query(batch));
        let timedOut = false;
        const result = await Promise.race([
          task.catch(() => null),
          new Promise<null>(resolve => { timeout = setTimeout(() => { timedOut = true; resolve(null); }, options.timeoutMs ?? 5_000); }),
        ]);
        clearTimeout(timeout);
        if (timedOut) {
          await task.catch(() => null);
          break; // No automatic retry of a timed-out read.
        }
        if (!owned(token)) break;
        const statuses = { ...snapshot.statuses };
        for (const url of batch) {
          const status = result?.[url];
          statuses[url] = status === 'cached' || status === 'missing' ? status : 'unknown';
        }
        snapshot = { ...snapshot, statuses };
        publish();
      }
    } finally {
      running = false;
      if (pending) void run();
    }
  }
  return {
    subscribe(subscriber: (value: AvailabilitySnapshot) => void) {
      subscribers.add(subscriber);
      subscriber(snapshot);
      if (subscribers.size === 1) {
        stopNetwork = options.listenNetwork?.(invalidate);
        stopCache = options.listenCache?.(invalidate);
        if (options.pollMs) timer = setInterval(() => {
          if (!snapshot.online && urls.length && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) invalidate();
        }, options.pollMs);
        invalidate();
      }
      return () => {
        subscribers.delete(subscriber);
        if (!subscribers.size) {
          epoch++; pending = false; stopNetwork?.(); stopCache?.(); clearInterval(timer);
          snapshot = { online: true, statuses: {} };
        }
      };
    },
    setTargets(next: readonly string[], nextContext = '') {
      const unique = [...new Set(next)];
      if (context === nextContext && unique.length === urls.length && unique.every((url, i) => url === urls[i])) return;
      urls = unique; context = nextContext;
      invalidate();
    },
  };
}

/** Complete cached rows stay visually unchanged. Unknown is never a cache miss. */
export function offlineRowHint(snapshot: AvailabilitySnapshot, url: string): string {
  if (snapshot.online || snapshot.statuses[url] === 'cached') return '';
  return snapshot.statuses[url] === 'missing' ? '未完整缓存 · 联网后可重试' : '离线可用性未知 · 可尝试播放';
}

/** Resolve fuller lyrics when available, but do not make month networking a
 * prerequisite for playing a retained audio snapshot. Abort/retired backend or
 * user operation MUST reject instead of falling back to stale source metadata.
 * One load per month per operation, including multi-song replace actions. */
export async function resolveBrowseAudios<T extends { id: string; monthId: string }>(
  audios: readonly T[],
  load: (monthId: string, signal?: AbortSignal) => Promise<T[]>,
  options: { signal?: AbortSignal; isCurrent: () => boolean },
): Promise<T[]> {
  const assertCurrent = () => {
    if (options.signal?.aborted || !options.isCurrent()) throw new DOMException('Aborted', 'AbortError');
  };
  assertCurrent();
  const months = new Map<string, Promise<T[] | null>>();
  return Promise.all(audios.map(async audio => {
    let pending = months.get(audio.monthId);
    if (!pending) {
      pending = Promise.resolve().then(() => { assertCurrent(); return load(audio.monthId, options.signal); }).catch(error => {
        assertCurrent();
        if (error?.name === 'AbortError') throw error;
        return null; // Retained metadata remains a valid playback attempt.
      });
      months.set(audio.monthId, pending);
    }
    const full = await pending;
    assertCurrent();
    return full?.find(candidate => candidate.id === audio.id) ?? audio;
  }));
}
