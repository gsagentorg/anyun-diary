import assert from 'node:assert/strict';
import {
  CACHE_POLICY_LIMITS,
  DEFAULT_CACHE_POLICY,
  NATIVE_CACHE_HOST,
  NATIVE_CACHE_METHODS,
  NATIVE_CACHE_PLUGIN,
  NATIVE_CACHE_SCHEME,
  audioFailureText,
  buildCacheAudioURL,
  clampCachePolicy,
  clearNativeCache,
  formatBytes,
  isCacheAudioURL,
  nativeAudioSrc,
  nativeCacheAvailable,
  nativeCacheStats,
  nativeFetchJSON,
  parseCacheAudioURL,
  setNativeCachePolicy,
} from '../src/lib/native-cache.ts';

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
const near = (actual, expected, message) => ok(Math.abs(actual - expected) < 1e-9, `${message} (${actual} ≠ ${expected})`);

// —— 常量契约：必须与 Swift 侧字面量一致 ——
eq(NATIVE_CACHE_SCHEME, 'anyun-cache', 'scheme constant');
eq(NATIVE_CACHE_HOST, 'media', 'media host constant');
eq(NATIVE_CACHE_PLUGIN, 'AnyunCache', 'plugin jsName');
eq([...NATIVE_CACHE_METHODS], ['configure', 'stats', 'clear', 'setPolicy', 'fetchJSON'], 'bridged method list');
eq(DEFAULT_CACHE_POLICY, {
  maxBytes: 536870912,
  maxEntries: 4000,
  mediaRevalidateSeconds: 604800,
  jsonStaleSeconds: 60,
}, 'policy defaults');

// —— 策略夹取：任何输入都落在范围内，缺字段沿用 base ——
near(clampCachePolicy(null).maxBytes, DEFAULT_CACHE_POLICY.maxBytes, 'null keeps base');
near(clampCachePolicy({}).jsonStaleSeconds, DEFAULT_CACHE_POLICY.jsonStaleSeconds, 'empty keeps base');
near(clampCachePolicy({ maxBytes: 1 }).maxBytes, CACHE_POLICY_LIMITS.maxBytes[0], 'tiny maxBytes clamped up');
near(clampCachePolicy({ maxBytes: 1e15 }).maxBytes, CACHE_POLICY_LIMITS.maxBytes[1], 'huge maxBytes clamped down');
near(clampCachePolicy({ maxEntries: 1 }).maxEntries, CACHE_POLICY_LIMITS.maxEntries[0], 'maxEntries floor');
near(clampCachePolicy({ maxEntries: 1e9 }).maxEntries, 20000, 'maxEntries ceiling');
near(clampCachePolicy({ mediaRevalidateSeconds: 1 }).mediaRevalidateSeconds, 3600, 'media revalidate floor');
near(clampCachePolicy({ mediaRevalidateSeconds: 1e9 }).mediaRevalidateSeconds, 2592000, 'media revalidate ceiling');
near(clampCachePolicy({ jsonStaleSeconds: 0 }).jsonStaleSeconds, 5, 'json stale floor');
near(clampCachePolicy({ jsonStaleSeconds: Number.NaN }).jsonStaleSeconds, 60, 'NaN keeps base');
near(clampCachePolicy({ maxBytes: '123' }).maxBytes, DEFAULT_CACHE_POLICY.maxBytes, 'non-number keeps base');
near(clampCachePolicy({ jsonStaleSeconds: 42.6 }).jsonStaleSeconds, 43, 'values rounded');
const custom = clampCachePolicy({ maxBytes: 1024 * 1024 * 1024 }, { ...DEFAULT_CACHE_POLICY, maxEntries: 900 });
near(custom.maxEntries, 900, 'unspecified fields inherit the provided base');
near(custom.maxBytes, 1073741824, 'specified field wins');

// —— scheme URL 构造/解析 ——
const remote = 'https://media.example.com/audio/a%20b(1).opus?x=1&y=2';
const schemeURL = buildCacheAudioURL(remote);
ok(typeof schemeURL === 'string' && schemeURL.startsWith('anyun-cache://media?u='), 'scheme url built');
eq(parseCacheAudioURL(schemeURL), remote, 'scheme url round-trips exactly');
ok(isCacheAudioURL(schemeURL), 'isCacheAudioURL detects the scheme url');
eq(buildCacheAudioURL('audio/x.opus'), null, 'relative url rejected');
eq(buildCacheAudioURL('http://insecure.example/x.opus'), null, 'http rejected (iOS ATS)');
eq(buildCacheAudioURL(''), null, 'empty url rejected');
eq(buildCacheAudioURL('not a url'), null, 'garbage rejected');
eq(parseCacheAudioURL('https://media.example.com/x.opus'), null, 'plain https is not a cache url');
eq(parseCacheAudioURL('anyun-cache://other?u=https%3A%2F%2Fa.example%2Fx.opus'), null, 'wrong host rejected');
eq(parseCacheAudioURL('anyun-cache://media?u=http%3A%2F%2Fa.example%2Fx.opus'), null, 'http target rejected');
eq(parseCacheAudioURL('anyun-cache://media'), null, 'missing u rejected');
eq(parseCacheAudioURL('anyun-cache://media?u=%E0%A4%A'), null, 'malformed encoding rejected');

// —— 音频地址适配 ——
const fakeApi = { stats: async () => ({ bytes: 0, entries: 0, mediaEntries: 0, jsonEntries: 0, maxBytes: 1 }) };
eq(nativeAudioSrc(remote, null), remote, 'no bridge keeps the plain url');
eq(nativeAudioSrc(remote, fakeApi), schemeURL, 'bridge rewrites audio urls');
eq(nativeAudioSrc('http://insecure.example/x.opus', fakeApi), 'http://insecure.example/x.opus', 'insecure url kept as-is');
eq(nativeAudioSrc('', fakeApi), '', 'empty src untouched');
ok(nativeCacheAvailable() === false, 'web/node reports no native cache');

// —— 索引 SWR 桥 ——
let seen = [];
const bridge = {
  async fetchJSON(options) {
    seen.push(options);
    return { data: { recordings: [1, 2] }, source: 'stale', ageSeconds: 42, offline: true };
  },
  async stats() {
    return { bytes: 2048, entries: 1, mediaEntries: 1, jsonEntries: 0, maxBytes: 4096, cacheDir: '/tmp/x' };
  },
  async clear(options) {
    seen.push({ clear: options.scope });
    return { freedBytes: 2048, entries: 1 };
  },
  async setPolicy(options) {
    return { policy: { ...DEFAULT_CACHE_POLICY, ...options.policy } };
  },
};
const cachedIndex = await nativeFetchJSON('https://a.example/data.json', { api: bridge });
eq(cachedIndex.data, { recordings: [1, 2] }, 'native index payload passed through');
eq(cachedIndex.source, 'stale', 'native index source kept');
eq(cachedIndex.offline, true, 'offline flag kept');
eq(seen.at(-1), { url: 'https://a.example/data.json' }, 'no force flag by default');
await nativeFetchJSON('https://a.example/data.json', { api: bridge, force: true });
eq(seen.at(-1), { url: 'https://a.example/data.json', force: true }, 'force forwarded');
eq(await nativeFetchJSON('https://a.example/data.json', { api: null }), null, 'no bridge → caller falls back to fetch');

const stats = await nativeCacheStats(bridge);
near(stats.bytes, 2048, 'stats passthrough');
eq(await nativeCacheStats(null), null, 'stats without bridge is null');
const cleared = await clearNativeCache(undefined, bridge);
eq(seen.at(-1), { clear: 'all' }, 'clear defaults to all scopes');
near(cleared.freedBytes, 2048, 'clear result passthrough');
const policy = await setNativeCachePolicy({ maxBytes: 1 }, bridge);
near(policy.maxBytes, CACHE_POLICY_LIMITS.maxBytes[0], 'setPolicy clamps before sending');
const brokenBridge = {
  async fetchJSON() { throw new Error('UNAVAILABLE: 离线且无缓存'); },
  async stats() { throw new Error('boom'); },
  async clear() { throw new Error('boom'); },
  async setPolicy() { throw new Error('boom'); },
};
await assert.rejects(() => nativeFetchJSON('https://a.example/data.json', { api: brokenBridge }), /UNAVAILABLE/);
ok(true, 'fetchJSON rejection propagates to the caller');
eq(await nativeCacheStats(brokenBridge), null, 'stats failure degrades to null');
eq(await clearNativeCache('media', brokenBridge), null, 'clear failure degrades to null');
eq(await setNativeCachePolicy({ maxBytes: 32_000_000 }, brokenBridge), null, 'setPolicy failure degrades to null');

// —— 展示与文案 ——
eq(formatBytes(0), '0 B', 'zero bytes');
eq(formatBytes(-5), '0 B', 'negative bytes');
eq(formatBytes(999), '999 B', 'bytes below 1 KiB');
eq(formatBytes(2048), '2.0 KB', 'kilobytes');
eq(formatBytes(536870912), '512.0 MB', 'megabytes');
eq(formatBytes(4294967296), '4.0 GB', 'gigabytes');
ok(audioFailureText(false).includes('未缓存') && !audioFailureText(false).includes('加载'), 'offline message names the cache gap');
ok(audioFailureText(true).includes('可重试'), 'online message offers retry');

// —— 设置面板：四档预设 + 选中态持久，且不暴露原生路径/内部夹取区间（#8）——
{
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  const sheet = await readFile(path.join(root, 'src/lib/components/CacheSheet.svelte'), 'utf8');
  const webSheet = await readFile(path.join(root, 'src/lib/components/WebCacheSheet.svelte'), 'utf8');
  const limitBlock = sheet.match(/const LIMIT_CHOICES = \[([\s\S]*?)\n  \];/)?.[1] ?? '';
  eq((limitBlock.match(/\{ label:/g) ?? []).length, 4, 'CacheSheet offers exactly four presets');
  for (const label of ['256 MB', '512 MB', '1 GB', '2 GB']) {
    ok(limitBlock.includes(`label: '${label}'`), `CacheSheet preset ${label}`);
  }
  ok(/value: 256 \* 1024 \* 1024/.test(limitBlock), 'CacheSheet 256 MB preset value');
  ok(/value: DEFAULT_CACHE_POLICY\.maxBytes/.test(limitBlock), 'CacheSheet 512 MB preset is the default policy');
  ok(/value: 1024 \* 1024 \* 1024/.test(limitBlock), 'CacheSheet 1 GB preset value');
  ok(/value: 2 \* 1024 \* 1024 \* 1024/.test(limitBlock), 'CacheSheet 2 GB preset value');
  const markup = sheet.slice(sheet.indexOf('</script>'));
  const webMarkup = webSheet.slice(webSheet.indexOf('</script>'));
  ok(!/cacheDir/.test(markup), 'CacheSheet renders no native cache path');
  ok(!/CACHE_POLICY_LIMITS/.test(markup), 'CacheSheet shows no internal clamp range constants');
  ok(!/范围/.test(markup), 'CacheSheet has no min–max range prose');
  ok(/超出上限时自动清理最久未听的缓存/.test(sheet), 'CacheSheet keeps a user-meaningful eviction note');
  ok(/stats\?\.bytes/.test(sheet) && /stats\?\.mediaEntries/.test(sheet), 'CacheSheet still shows usage and entry counts');
  ok(/clear\('media'\)|clear\('all'\)/.test(sheet), 'CacheSheet keeps the clear actions');
  // 网页端同款：只保留四档预设与默认值说明，不展示夹取区间。
  eq((webSheet.match(/\{ label: '/g) ?? []).length, 4, 'WebCacheSheet offers exactly four presets');
  ok(!/WEB_AUDIO_MIN_BYTES|WEB_AUDIO_MAX_LIMIT/.test(webMarkup), 'WebCacheSheet shows no internal clamp range constants');
  ok(!/范围/.test(webMarkup), 'WebCacheSheet has no min–max range prose');
}

// —— 面板状态往返：选中档位持久、清理后占用回落 ——
{
  const policyBridge = (() => {
    let maxBytes = DEFAULT_CACHE_POLICY.maxBytes;
    let bytes = 2048;
    let entries = 2;
    return {
      async stats() {
        return { bytes, entries, mediaEntries: 1, jsonEntries: entries - 1, maxBytes, cacheDir: '/diagnostics/only' };
      },
      async setPolicy({ policy: next }) {
        maxBytes = clampCachePolicy(next).maxBytes;
        return { policy: { ...DEFAULT_CACHE_POLICY, maxBytes } };
      },
      async clear() {
        const freedBytes = bytes;
        bytes = 0;
        entries = 0;
        return { freedBytes, entries: 2 };
      },
      async fetchJSON() {
        throw new Error('unused');
      },
    };
  })();
  near((await nativeCacheStats(policyBridge)).maxBytes, DEFAULT_CACHE_POLICY.maxBytes, 'panel opens on the default limit');
  const chosen = await setNativeCachePolicy({ maxBytes: 1024 * 1024 * 1024 }, policyBridge);
  near(chosen.maxBytes, 1073741824, 'choosing 1 GB applies that preset');
  near((await nativeCacheStats(policyBridge)).maxBytes, 1073741824, 'selected preset persists across panel refresh');
  const before = await nativeCacheStats(policyBridge);
  ok(before.bytes === 2048 && before.entries === 2, 'usage and entry counts visible before clearing');
  const clearedPanel = await clearNativeCache('media', policyBridge);
  near(clearedPanel.freedBytes, 2048, 'clear reports freed bytes');
  const afterClear = await nativeCacheStats(policyBridge);
  near(afterClear.bytes, 0, 'usage resets after clearing');
  near(afterClear.entries, 0, 'entry counts reset after clearing');
  near(afterClear.maxBytes, 1073741824, 'clearing keeps the selected limit');
}

console.log(`native-cache: ${checks} checks passed`);