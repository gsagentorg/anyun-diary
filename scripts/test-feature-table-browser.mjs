/** Production Node UI acceptance. No installs, live data, public endpoints or application mocks. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { monthBounds, monthIdAt } from '../src/lib/month.js';

const { PLAYWRIGHT_MODULE, CHROMIUM_PATH } = process.env;
if (!PLAYWRIGHT_MODULE || !CHROMIUM_PATH) throw Error('Set PLAYWRIGHT_MODULE and CHROMIUM_PATH; missing browser is a failure, not a skip');
const { chromium } = await import(PLAYWRIGHT_MODULE);
const results = [], external = [], serverErrors = [];
const now = Math.floor(Date.now() / 1000);
const today = Math.floor((now + 28800) / 86400) * 86400 - 28800;
// Five empty days after the recordings make the heatmap tail assertion meaningful.
const start = today - 5 * 86400 + 12 * 3600;
const id = monthIdAt(start), bounds = monthBounds(id);
const hashes = ['a'.repeat(64), 'b'.repeat(64)];
const tracks = hashes.map((hash, i) => ({ id: 'fixture-' + i, file: 'synthetic-' + i + '.wav', opus: 'audio/' + hash + '.opus', title: 'Synthetic track ' + (i ? 'Beta' : 'Alpha'), startAt: start + i * 180, duration: 120, monthId: id, lyrics: [{ t: 0, text: 'Synthetic fixture lyric ' + i }] }));
const month = { schemaVersion: 2, id, revision: 'fixture-month', audios: tracks };
const manifest = { schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: now, revision: 'fixture-release', months: [{ id, ...bounds, count: tracks.length, revision: month.revision, key: 'months/fixture.json', available: true }] };
function wav(seconds) {
 const samples = 8000 * seconds, b = Buffer.alloc(44 + samples * 2);
 b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
 for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), 44 + i * 2);
 return b;
}
const audio = wav(120);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const servers = [], contexts = [];
let browser, apiReads = 0, imageReads = 0;
async function listen(server) {
 servers.push(server);
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 return 'http://127.0.0.1:' + server.address().port;
}
async function check(name, fn) {
 try { const evidence = await fn(); results.push({ name, status: 'PASS', evidence }); }
 catch (e) { results.push({ name, status: 'FAIL', error: e.stack || String(e) }); }
 console.log(JSON.stringify(results.at(-1)));
}
try {
 const brandOrigin = await listen(http.createServer((req, res) => {
  imageReads++;
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' });
  // Deliberately no Access-Control-Allow-Origin.
  res.end(png);
 }));
 // Set before handler import: adapter-node initializes dynamic public env at import time.
 process.env.PUBLIC_BRAND_BASE = brandOrigin + '/brand/';
 process.env.PUBLIC_AUDIO_BASE = '';
 const { handler } = await import('../build/handler.js');
 const origin = await listen(http.createServer((req, res) => {
  const u = new URL(req.url, 'http://fixture.invalid');
  const json = v => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
  if (u.pathname === '/api/current') { apiReads++; return json({ schemaVersion: 2, releaseId: 'c'.repeat(64), key: 'releases/' + 'c'.repeat(64) + '/manifest.json' }); }
  if (u.pathname === '/api/catalog') { apiReads++; return json(manifest); }
  if (u.pathname.startsWith('/api/month/')) { apiReads++; return json(month); }
  if (hashes.some(h => u.pathname === '/api/audio/' + h + '.opus')) {
   if (u.searchParams.get('resolve') === '1') return json({ url: u.pathname + '?delivery=fixture', expiresAt: null });
   res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' }); return res.end(audio);
  }
  // No live APIs/storage code can run through this fixture gateway.
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/brand/')) { res.writeHead(404); return res.end(); }
  if (!(u.pathname === '/' || u.pathname === '/service-worker.js' || u.pathname.startsWith('/_app/') || ['/favicon', '/icon', '/manifest'].some(p => u.pathname.startsWith(p)))) { res.writeHead(404); return res.end(); }
  Promise.resolve(handler(req, res)).catch(e => { serverErrors.push(e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
 }));
 browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
 async function setup() {
  // SW is blocked in this suite so every network request obeys the two-origin allowlist.
  // Actual SW cold-shell coverage belongs to test-offline-app-browser.mjs.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });
  contexts.push(context);
  await context.route('**/*', route => {
   const url = route.request().url();
   if (url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
   if ([origin, brandOrigin].includes(new URL(url).origin)) return route.continue();
   external.push({ type: route.request().resourceType(), url: new URL(url).protocol + '//blocked.invalid' });
   return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
  return { context, page, errors };
 }
 async function begin(page) {
  await page.locator('button[title="用这一天的歌替换播放列表"]').first().click();
  await page.waitForFunction(() => window.__anyunAudio && !window.__anyunAudio.paused && window.__anyunAudio.currentTime > 0.2);
 }
 async function control(page, name) {
  let target = page.getByRole('button', { name, exact: true });
  if (!await target.count() || !await target.first().isVisible()) await page.getByRole('button', { name: '更多功能', exact: true }).click();
  return page.getByRole('button', { name, exact: true });
 }
 async function queue(page) {
  await (await control(page, '播放队列')).click();
  const dialog = page.getByRole('dialog', { name: '播放队列', exact: true });
  await dialog.waitFor({ state: 'visible' }); return dialog;
 }
 async function audioState(page) { return page.evaluate(() => { const a = window.__anyunAudio; return { paused: a.paused, time: a.currentTime, src: a.currentSrc || a.src }; }); }
 await check('mode-three-state-order', async () => {
  const { page, errors } = await setup(); await begin(page);
  const names = ['顺序播放', '随机播放', '单曲循环', '顺序播放', '随机播放'];
  for (let i = 0; i < names.length - 1; i++) {
   await (await control(page, '播放模式：' + names[i])).click();
   assert.equal(await page.getByRole('button', { name: '播放模式：' + names[i + 1], exact: true }).count(), 1);
  }
  assert.deepEqual(errors, []); return { order: names };
 });
 await check('next-enabled-at-shuffled-tail', async () => {
  const { page, errors } = await setup(); await begin(page);
  const next = page.getByRole('button', { name: '下一首', exact: true });
  // 播放源可能是网络 URL 也可能是 blob，用常驻计数「pos/total」判定当前曲目
  const at = (label) => page.waitForFunction(l => {
   const a = window.__anyunAudio;
   const counter = document.querySelector('[aria-label="下一首"]')?.previousElementSibling;
   return counter?.textContent.trim() === l && !a.paused && a.currentTime > 0.2;
  }, label);
  // 顺序模式走到队尾：下一首随即禁用（原有行为不变）
  await next.click(); await at('2/2');
  assert.equal(await next.isDisabled(), true, 'sequential tail keeps next disabled');
  // 切到随机：抽曲逻辑上还有一首可选，下一首必须可用并能真的换曲
  await (await control(page, '播放模式：顺序播放')).click();
  await page.getByRole('button', { name: '播放模式：随机播放', exact: true }).waitFor();
  assert.equal(await next.isDisabled(), false, 'shuffle tail must enable next');
  await next.click(); await at('1/2');
  // 随机模式再回到队尾：自然播完也应换到另一首合格曲目
  await next.click(); await at('2/2');
  await page.evaluate(() => { const a = window.__anyunAudio; a.currentTime = Math.max(0, a.duration - 0.15); });
  await at('1/2');
  assert.deepEqual(errors, []); return { sequentialTailDisabled: true, shuffleTailEnabled: true, shuffledNaturalEndAdvances: true };
 });
 await check('clear-direct-footer-button-no-menu-and-never-restores', async () => {
  const { page, errors } = await setup(); await begin(page);
  const clear = page.getByRole('button', { name: '清空播放列表（停止播放）', exact: true });
  assert.equal(await clear.count(), 0, 'clear must not exist in primary controls');
  assert.equal(await page.getByRole('button', { name: '关闭播放器', exact: true }).count(), 0, 'misleading close button removed from primary controls');
  const dialog = await queue(page);
  assert.equal(await clear.count(), 1, 'clear must be directly visible in the queue sheet');
  assert.ok(await clear.isVisible(), 'clear must not hide behind a menu');
  assert.equal(await dialog.getByRole('button', { name: '队列操作', exact: true }).count(), 0, 'no intermediate queue-actions menu');
  assert.equal(await dialog.getByRole('group', { name: /队列第/ }).count(), 2);
  await clear.click();
  await page.waitForFunction(() => window.__anyunAudio.paused);
  assert.equal(await page.locator('[aria-label^="队列第 "]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '关闭播放器', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('anyun-session-v2')), null);
  const stopped = await audioState(page);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => localStorage.getItem('anyun-session-v2')), null, 'late debounced save cannot resurrect the snapshot');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
  assert.equal(await page.getByRole('button', { name: '播放队列', exact: true }).count(), 0, 'reload cannot restore the cleared player/queue');
  assert.equal(await page.locator('[aria-label^="队列第 "]').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('anyun-session-v2')), null);
  assert.deepEqual(errors, []); return stopped;
 });
 await check('running-sleep-line-drag-minimum-and-pointercancel-chromium', async () => {
  const { page, errors } = await setup(); await begin(page);
  await (await control(page, '睡眠定时器')).click();
  await page.getByRole('button', { name: '15分', exact: true }).click();
  const svg = page.locator('svg[aria-label*="音量变化示意"]');
  await page.locator('[data-sleep-handle]').waitFor();
  async function point(targetX) {
   return svg.evaluate((el, targetX) => {
    const c = el.querySelector('[data-sleep-position]');
    const x = Number(c.getAttribute('cx')), cy = Number(c.getAttribute('cy'));
    const y = cy < 22 ? 37 : 6;
    const matrix = el.getScreenCTM();
    const p = new DOMPoint(x, y).matrixTransform(matrix), end = new DOMPoint(targetX, y).matrixTransform(matrix);
    return { x: p.x, y: p.y, endX: end.x, endY: end.y, distanceFromDot: Math.abs(y - cy) };
   }, targetX);
  }
  let p = await point(90); assert.ok(p.distanceFromDot > 10, 'start on vertical line, well outside circle');
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.endX, p.endY, { steps: 8 }); await page.mouse.up();
  const midway = Number(await page.locator('[data-sleep-handle]').getAttribute('aria-valuenow'));
  assert.ok(midway >= 48 && midway <= 52, 'line drag should move to midpoint: ' + midway);
  p = await point(180); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.endX, p.endY, { steps: 8 });
  const clamped = Number(await page.locator('[data-sleep-handle]').getAttribute('aria-valuenow'));
  const remainingText = await page.getByRole('status').filter({ hasText: /进行中：.*剩余/ }).innerText();
  assert.ok(clamped >= 92 && clamped <= 93, '15 minute run must clamp at 14 minutes elapsed: ' + clamped);
  assert.match(remainingText, /剩余 01:00/, 'drag must retain at least one minute at application time: ' + remainingText);
  // Browser-generated mouse pointerdown/move above; only the cancellation event is injected.
  await svg.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
  await page.mouse.move(p.x, p.y, { steps: 6 }); await page.mouse.up();
  const afterCancel = Number(await page.locator('[data-sleep-handle]').getAttribute('aria-valuenow'));
  assert.ok(Math.abs(afterCancel - clamped) <= 1, 'cancel must not revert or continue dragging');
  assert.deepEqual(errors, []); return { midway, clamped, remainingText, afterCancel, engine: 'Chromium; not iOS' };
 });
 await check('custom-sleep-editor-live-preview-and-running-snapshot', async () => {
  const { page, errors } = await setup(); await begin(page);
  await (await control(page, '睡眠定时器')).click();
  await page.getByRole('combobox').selectOption('custom');
  const editor = page.locator('[data-sleep-editor]'); await editor.waitFor();
  assert.equal(await editor.getByRole('slider').count(), 4);
  assert.equal(await editor.getByRole('spinbutton').count(), 4);
  const preview = editor.locator('[data-sleep-custom-preview] path').last();
  const active = page.locator('svg[aria-label*="音量变化示意"] path').last();
  const hold = editor.getByRole('spinbutton', { name: '保持原音量（%）数值', exact: true });
  await hold.fill('50');
  await page.getByRole('button', { name: '15分', exact: true }).click();
  const running = await active.getAttribute('d');
  assert.equal(running, await preview.getAttribute('d'));
  await hold.fill('70');
  assert.equal(await active.getAttribute('d'), running, 'edits must not replace running curve');
  assert.notEqual(await preview.getAttribute('d'), running);
  await editor.getByRole('button', { name: '恢复默认参数', exact: true }).click();
  assert.equal(await active.getAttribute('d'), running);
  assert.equal(await hold.inputValue(), '30');
  await page.getByRole('button', { name: '15分', exact: true }).click();
  assert.equal(await active.getAttribute('d'), await preview.getAttribute('d'));
  assert.notEqual(await active.getAttribute('d'), running);
  assert.equal((await audioState(page)).paused, false);
  assert.deepEqual(errors, []); return { controls: 4, nextRunIsolated: true, restartApplies: true };
 });
 await check('refresh-preserves-playing-queue-and-reload-confirmation', async () => {
  const { page, errors } = await setup(); await begin(page);
  const dialog = await queue(page);
  const beforeQueue = await dialog.getByRole('group', { name: /队列第/ }).allTextContents();
  await dialog.locator('button[aria-label="关闭"]').click();
  const marker = await page.evaluate(() => window.__featureDocument = Math.random().toString(36));
  let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const before = await audioState(page), readsBefore = apiReads;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const refresh = page.getByRole('dialog', { name: '刷新与恢复', exact: true });
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/current') && r.status() === 200), refresh.getByRole('button', { name: '刷新数据', exact: true }).click()]);
  await page.waitForFunction(() => document.querySelector('[aria-label="刷新与恢复"] [role="status"]')?.textContent.includes('目录已加载'));
  assert.ok(apiReads > readsBefore, 'refresh must actually check fixture API');
  const after = await audioState(page);
  assert.equal(after.paused, false); assert.equal(after.src, before.src); assert.ok(after.time >= before.time);
  assert.equal(await page.evaluate(() => window.__featureDocument), marker); assert.equal(navigations, 0);
  await refresh.getByRole('button', { name: '重新载入页面', exact: true }).click();
  assert.equal(await refresh.getByRole('button', { name: '确认重载', exact: true }).count(), 1);
  assert.equal(navigations, 0, 'requesting reload must only show confirmation');
  await refresh.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await refresh.getByRole('button', { name: '确认重载', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__featureDocument), marker); assert.equal(navigations, 0);
  await page.locator('[role="presentation"]').click({ position: { x: 10, y: 10 } });
  const afterDialog = await queue(page);
  assert.deepEqual(await afterDialog.getByRole('group', { name: /队列第/ }).allTextContents(), beforeQueue);
  assert.equal((await audioState(page)).paused, false);
  await afterDialog.locator('button[aria-label="关闭"]').click();
  // Positive confirmation proves the cancel assertion is not a broken reload button.
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await refresh.getByRole('button', { name: '重新载入页面', exact: true }).click();
  await Promise.all([page.waitForEvent('framenavigated', { predicate: f => f === page.mainFrame() }), refresh.getByRole('button', { name: '确认重载', exact: true }).click()]);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
  assert.equal(await page.evaluate(() => window.__featureDocument), undefined); assert.equal(navigations, 1);
  assert.deepEqual(errors, []); return { queueSize: beforeQueue.length, refreshKeptPlayback: true, cancelledReloads: 0, confirmedReloads: navigations };
 });
 await check('offline-recovery-and-two-distinct-complete-cache-states', async () => {
  const { page, context, errors } = await setup(); await begin(page);
  await page.waitForFunction(async () => (await (await caches.open('anyun-web-audio-v1')).keys()).length === 1);
  const cachedKeys = await page.evaluate(async () => (await (await caches.open('anyun-web-audio-v1')).keys()).map(r => r.url));
  assert.ok(cachedKeys.some(k => k.includes('a'.repeat(64))));
  assert.ok(!cachedKeys.some(k => k.includes('b'.repeat(64))));
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await context.setOffline(true);
  const readsBefore = apiReads;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('dialog', { name: '刷新与恢复' }).getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.waitForFunction(() => { const t = document.querySelector('[aria-label="刷新与恢复"] [role="status"]')?.textContent || ''; return !t.includes('正在检查') && !t.includes('目录已加载'); });
  assert.equal(apiReads, readsBefore, 'offline refresh cannot reach server');
  await page.locator('[role="presentation"]').click({ position: { x: 10, y: 10 } });
  // Discard media/blob/catalog in-memory state, but retain the complete cache.
  // Network is restored for loading JS only; then disabled before the first play gesture.
  await context.setOffline(false); await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
  await page.getByRole('button', { name: '播放', exact: true }).waitFor();
  await context.setOffline(true);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => window.__anyunAudio.src.startsWith('blob:') && !window.__anyunAudio.paused && window.__anyunAudio.currentTime > 0.2);
  const cachedPlayback = await audioState(page);
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await page.waitForFunction(() => window.__anyunAudio.paused);
  await page.getByRole('alert').filter({ hasText: /离线|播放|网络/ }).first().waitFor();
  assert.equal(await page.evaluate(async () => (await (await caches.open('anyun-web-audio-v1')).keys()).some(r => r.url.includes('b'.repeat(64)))), false);
  const recoveryReads = apiReads;
  // Arm before network restoration so the online-event request cannot race the observer.
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/current') && r.status() === 200), context.setOffline(false)]);
  await page.waitForFunction(() => navigator.onLine);
  assert.ok(apiReads > recoveryReads);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => !window.__anyunAudio.paused && window.__anyunAudio.currentTime > 0.2);
  assert.deepEqual(errors, []); return { alphaComplete: true, betaInitiallyAbsent: true, cachedPlayback, onlineEventRecovery: true };
 });
 await check('cross-origin-brand-without-acao-or-crossorigin', async () => {
  const { page, errors } = await setup();
  const image = page.locator('[data-brand-image="安允日记"]');
  await image.waitFor(); await image.evaluate(img => img.decode());
  const state = await image.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight, src: img.currentSrc, crossorigin: img.hasAttribute('crossorigin') }));
  assert.equal(new URL(state.src).origin, brandOrigin); assert.notEqual(brandOrigin, origin);
  assert.ok(state.width > 0); assert.equal(state.crossorigin, false); assert.ok(imageReads > 0);
  const response = await page.request.get(brandOrigin + '/brand/avatar.png');
  assert.equal(response.headers()['access-control-allow-origin'], undefined);
  assert.deepEqual(errors, []); return { decoded: true, crossOrigin: true, acao: false, crossorigin: false };
 });
 await check('heatmap-tail-reaches-today-with-empty-days', async () => {
  const { page, errors } = await setup();
  await page.getByRole('tab', { name: '热力图', exact: true }).click();
  const scroll = page.locator('[data-heat-scroll]'); await scroll.waitFor();
  await scroll.evaluate(el => el.scrollLeft = 0);
  // Columns are newest-first: the chronological upper tail is the first column.
  const last = page.locator('[data-heat-col]').first();
  await page.locator('[data-heat-col][data-heat-today="true"]').waitFor();
  assert.equal(Number(await last.getAttribute('data-heat-col')), today);
  assert.equal(await last.getAttribute('data-heat-today'), 'true');
  assert.equal(await last.locator('button:disabled').count(), 24);
  assert.ok(today > start + 4 * 86400, 'fixture recordings must predate empty tail');
  assert.deepEqual(errors, []); return { lastDay: today, today, emptyTodayHours: 24, recordingDay: start };
 });
 // Strict integration hook: the old build fails visibly until per-row UI is built.
 await check('per-track-visual-cache-indicators', async () => {
  const { page, context } = await setup(); await begin(page);
  await page.waitForFunction(async () => (await (await caches.open('anyun-web-audio-v1')).keys()).length === 1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const dialog = await queue(page);
  await context.setOffline(true);
  const rows = dialog.getByRole('group', { name: /队列第/ });
  assert.equal(await rows.count(), 2);
  await dialog.locator('[data-offline-availability="cached"]').waitFor();
  assert.equal(await rows.nth(0).getAttribute('data-offline-availability'), 'cached', 'integration hook: Alpha row needs cached visual indicator');
  assert.equal(await rows.nth(1).getAttribute('data-offline-availability'), 'missing', 'integration hook: Beta row needs uncached visual indicator');
  assert.doesNotMatch(await rows.nth(0).innerText(), /未完整缓存|离线可用性未知/);
  assert.match(await rows.nth(1).innerText(), /未完整缓存 · 联网后可重试/);
  assert.equal(await rows.nth(1).evaluate(el => el.classList.contains('offline-missing')), true);
  return { alpha: 'cached', beta: 'missing' };
 });
 assert.deepEqual(serverErrors, []);
} finally {
 for (const context of contexts) await context.close().catch(() => {});
 if (browser) await browser.close();
 for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const failed = results.filter(r => r.status !== 'PASS');
console.log('feature table browser:', JSON.stringify({ passed: results.length - failed.length, failed: failed.length, externalRequestsBlocked: external.length, serverErrors, results }));
if (failed.length) process.exitCode = 1;
