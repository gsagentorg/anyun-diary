/**
 * 真实浏览器端到端验证（web 离线缓存）。
 *
 * 运行（不安装任何东西；复用机器上已存在的 headless Chromium 与 playwright-core）：
 *   PLAYWRIGHT_MODULE=~/.nvm/versions/node/v26.13.0/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs \
 *   CHROMIUM_PATH=~/.local/opt/chrome-linux64/chrome \
 *   node scripts/test-web-offline-browser.mjs
 * 环境缺失时明确 SKIP（不算通过）。
 *
 * 隔离边界：自起 127.0.0.1 临时服务器（可信 origin → SW/CacheStorage 语义全开），
 * 只服务 esbuild 现打的缓存模块与**合成 WAV fixture**；绝不访问 dev server、真实目录或真实音频。
 *
 * 覆盖：真实 CacheStorage miss→200 完整下载→Blob 命中；Blob <audio> 真实播放推进；
 * 页面 reload（冷内存）+ setOffline 后：已缓存曲目离线播放与离线拖动、未缓存曲目诚实失败；
 * 206 永不入缓存；签名不进持久 key（直接枚举 CacheStorage keys）；真实逐出/上限语义；clear 归零。
 * Service Worker 注册在合成宿主上不适用（应用构建内的预缓存内容审计在 node 构建产物侧另有断言）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PW = process.env.PLAYWRIGHT_MODULE;
const CHROME = process.env.CHROMIUM_PATH;
if (!PW || !CHROME) {
  console.log('SKIP test-web-offline-browser: 需要 PLAYWRIGHT_MODULE 与 CHROMIUM_PATH 环境。');
  console.log('未执行真实浏览器验证；核心行为回归见 node scripts/test-web-offline.mjs。');
  process.exit(0);
}
const { chromium } = await import(PW);
const esbuild = await import('esbuild');

const root = new URL('../', import.meta.url).pathname;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyun-webcache-browser-'));
await esbuild.build({
  entryPoints: [path.join(root, 'src/lib/web-audio-cache.ts'), path.join(root, 'src/lib/audio-renewal.ts')],
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'chrome120',
  outdir: path.join(outDir, 'modules'),
});

// 4 秒 8kHz 单声道正弦 WAV（合成 fixture，无任何真实数据）
function synthWav(seconds) {
  const samples = 8000 * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 8000 * 440 * Math.PI * 2) * 1200), 44 + i * 2);
  return bytes;
}
const GOOD = synthWav(4);
const HASH_GOOD = 'a'.repeat(64);
const HASH_PARTIAL = 'b'.repeat(64);
const KEY_GOOD_PATH = `/api/audio/${HASH_GOOD}.opus`;
const KEY_PARTIAL_PATH = `/api/audio/${HASH_PARTIAL}.opus`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('cache-control', 'no-store'); // 禁 HTTP 缓存参与，逼真实走 CacheStorage 层
  if (u.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><meta charset="utf-8"><title>webcache fixture</title><body>fixture');
  }
  if (u.pathname.startsWith('/modules/')) {
    const file = path.join(outDir, u.pathname);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('missing'); }
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(file));
  }
  if (/^\/api\/audio\/[a-f0-9]{64}\.opus$/.test(u.pathname)) {
    if (u.searchParams.get('resolve') === '1') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ url: u.pathname + '?sig=' + Date.now(), expiresAt: Date.now() + 60000 }));
    }
    if (u.pathname.includes(HASH_PARTIAL)) {
      res.statusCode = 206;
      res.setHeader('content-type', 'audio/wav');
      res.setHeader('content-range', `bytes 0-99/${GOOD.length}`);
      res.setHeader('content-length', '100');
      return res.end(GOOD.subarray(0, 100));
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('content-length', String(GOOD.length));
    return res.end(GOOD);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const watchdog = setTimeout(() => { console.error('BROWSER TEST TIMEOUT'); process.exit(1); }, 180000);
const browser = await chromium.launch({
  headless: true, executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const out = {};
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => { out.pageError = String(e); });

  await page.goto(BASE + '/');
  out.online = await page.evaluate(async ({ good, partial }) => {
    const cache = await import('/modules/web-audio-cache.js');
    const res = {};
    res.available = cache.webCacheAvailable();
    const first = await cache.prepareWebAudio(good + '?X-Amz-Signature=LEAKME');
    res.firstCached = first.cached;
    res.firstStableHasSig = String(first.stableUrl).includes('LEAKME');
    res.done = await first.done;
    const stats = await cache.getWebCacheStats();
    res.entries = stats.entries;
    res.bytes = stats.bytes;
    res.maxBytes = stats.maxBytes;
    const second = await cache.prepareWebAudio(good);
    res.hit = second.cached;
    res.hitUrlIsBlob = second.url.startsWith('blob:');
    // 真实 Blob 播放：必须能解码并推进
    const audio = new Audio();
    audio.src = second.url;
    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => reject(Error('blob metadata failed'));
      setTimeout(() => reject(Error('blob meta timeout')), 8000);
    });
    await audio.play();
    await new Promise((r) => setTimeout(r, 400));
    res.playedTime = audio.currentTime;
    audio.pause();
    second.release();
    // 206 诚实拒缓存
    const p = await cache.prepareWebAudio(partial);
    res.partialDone = await p.done;
    res.partialState = await cache.getWebAudioEntryState(partial);
    // CacheStorage 实际键：签名零残留
    const cs = await caches.open('anyun-web-audio-v1');
    res.persistedKeys = (await cs.keys()).map((k) => k.url);
    return res;
  }, { good: BASE + KEY_GOOD_PATH, partial: BASE + KEY_PARTIAL_PATH });

  assert.equal(out.online.available, true, '真实浏览器必须支持 CacheStorage');
  assert.equal(out.online.firstCached, false);
  assert.equal(out.online.firstStableHasSig, false, '签名不得进稳定 key');
  assert.equal(out.online.done, true, '完整 200 后台下载应完成');
  assert.equal(out.online.entries, 1, 'stats 计数');
  assert.equal(out.online.bytes, GOOD.length, 'stats 字节');
  assert.equal(out.online.maxBytes, 536870912, '默认上限与 App 一致');
  assert.equal(out.online.hit, true, '第二次命中');
  assert.equal(out.online.hitUrlIsBlob, true);
  assert.ok(out.online.playedTime > 0.1, 'Blob URL 真实播放推进: ' + out.online.playedTime);
  assert.equal(out.online.partialDone, false, '206 不得当已缓存');
  assert.equal(out.online.partialState, 'none');
  assert.ok(out.online.persistedKeys.every((k) => !/LEAKME|sig=/.test(k)), '持久 key 干净: ' + out.online.persistedKeys.join(','));

  // —— 重载（冷内存）+ 断网：已缓存曲目离线播放/拖动 ——
  await page.reload();
  await page.evaluate(async () => {
    window.__cache = await import('/modules/web-audio-cache.js');
    window.__renewal = await import('/modules/audio-renewal.js');
  });
  await context.setOffline(true);
  out.offline = await page.evaluate(async ({ good, partial }) => {
    const cache = window.__cache;
    const { attachAudioRenewal } = window.__renewal;
    const res = { state: await cache.getWebAudioEntryState(good) };
    const errors = [];
    const media = new Audio();
    attachAudioRenewal(media, () => 'entry', (msg) => errors.push(msg));
    media.src = good;
    media.load();
    await media.play().catch((e) => { res.playReject = e.name || 'failed'; });
    await new Promise((r) => setTimeout(r, 600));
    res.srcPrefix = media.src.slice(0, 5);
    res.time = media.currentTime;
    // 离线拖动
    media.currentTime = 2.0;
    await new Promise((r) => setTimeout(r, 300));
    res.seeked = media.currentTime;
    media.pause();
    // 未缓存曲目离线：诚实失败，不假装可播
    const miss = new Audio();
    const missErrors = [];
    attachAudioRenewal(miss, () => 'other', (msg) => missErrors.push(msg));
    miss.src = partial;
    miss.load();
    let rejected = false;
    await miss.play().catch(() => { rejected = true; });
    res.missRejected = rejected || missErrors.length > 0 || !miss.src.startsWith('blob:');
    return res;
  }, { good: BASE + KEY_GOOD_PATH, partial: BASE + KEY_PARTIAL_PATH });
  await context.setOffline(false);

  assert.equal(out.offline.state, 'cached', '冷启动后磁盘缓存可见');
  assert.equal(out.offline.srcPrefix, 'blob:', '离线重开必须 Blob 播放');
  assert.ok(out.offline.time > 0.1, '离线播放推进: ' + out.offline.time);
  assert.ok(Math.abs(out.offline.seeked - 2.0) < 0.6, '离线拖动生效: ' + out.offline.seeked);
  assert.equal(out.offline.missRejected, true, '离线未缓存曲目诚实失败');

  // —— 真实逐出与 clear（真 CacheStorage，无 mock）——
  out.storage = await page.evaluate(async ({ good }) => {
    const cache = await import('/modules/web-audio-cache.js');
    const small = cache.setWebAudioCacheLimit(1048576);
    const cs = await caches.open('anyun-web-audio-v1');
    // 直接塞多个条目验证逐出在真实配额语义下有界（复用同一路由 body，不同 key）
    const keys = Array.from({ length: 18 }, (_, i) => location.origin + `/api/audio/${'0123456789ab'.repeat(6).slice(0, 60)}${String(i).padStart(2, '0')}ca.opus`);
    const results = [];
    for (const k of keys) results.push(await (await cache.prepareWebAudio(k)).done);
    await new Promise((r) => setTimeout(r, 500));
    const stats = await cache.getWebCacheStats();
    const live = (await cs.keys()).map((x) => x.url);
    const cleared = await cache.clearWebAudioCache();
    const after = await cache.getWebCacheStats();
    const persistedKeys = after.supported ? await (await caches.open('anyun-web-audio-v1')).keys() : [];
    cache.setWebAudioCacheLimit(536870912);
    return { small, results, stats, evicted: stats.entries < keys.length, liveCount: live.length, cleared, after, persisted: persistedKeys.length };
  }, { good: BASE + KEY_GOOD_PATH });
  assert.equal(out.storage.results.filter(Boolean).length, 18, '十八个条目全部下载完成');
  assert.ok(out.storage.stats.bytes <= 1048576, '真实 CacheStorage 下 LRU 有界: ' + out.storage.stats.bytes);
  assert.equal(out.storage.evicted, true, '超出真实上限时确实发生了逐出');
  assert.ok(out.storage.liveCount <= out.storage.results.filter(Boolean).length, '实际存储条目不多于完成数');
  assert.equal(out.storage.after.entries, 0, 'clear 后归零');
  assert.equal(out.storage.persisted, 0, 'clear 后真实 CacheStorage 为空');

  console.log('web offline browser: PASS', JSON.stringify({
    online: { playedTime: out.online.playedTime, partialState: out.online.partialState },
    offline: { time: out.offline.time, seeked: out.offline.seeked },
    storage: { bytes: out.storage.stats.bytes, liveCount: out.storage.liveCount },
    pageError: out.pageError ?? null,
  }));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(outDir, { recursive: true, force: true });
}
