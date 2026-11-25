/** Issue #10: at a narrow viewport the time-compression strip must not show through an
 * unavailable track card. Synthetic data, offline, Chromium only; no live APIs.
 * Evidence is pixel-based: the same column is sampled with the cards visible and hidden,
 * so "strip visible outside the card" and "strip hidden beneath the card" are both measured. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { monthBounds, monthIdAt } from '../src/lib/month.js';

const { PLAYWRIGHT_MODULE, CHROMIUM_PATH } = process.env;
if (!PLAYWRIGHT_MODULE || !CHROMIUM_PATH) throw Error('Set PLAYWRIGHT_MODULE and CHROMIUM_PATH; missing browser is a failure, not a skip');
const { chromium } = await import(PLAYWRIGHT_MODULE);

const now = Math.floor(Date.now() / 1000);
const today = Math.floor((now + 28800) / 86400) * 86400 - 28800;
// 12:00 Shanghai: a cluster of short slices (min-width layout pushes the last card into the
// following blank) plus two late slices so the lane keeps a wide blank strip as well.
const start = today - 3 * 86400 + 12 * 3600;
const id = monthIdAt(start), bounds = monthBounds(id);
const specs = [
  ...Array.from({ length: 10 }, (_, i) => ({ offset: i * 120, duration: 60 })),
  { offset: 11 * 3600, duration: 60 },
  { offset: 11 * 3600 + 600, duration: 60 },
];
// Same-origin cache keys require the real 64-hex audio route shape, otherwise the
// availability query reports "unknown" instead of the confirmed "missing" we need.
const hashes = specs.map((_, i) => (i + 1).toString(16).padStart(2, '0').repeat(32));
const tracks = specs.map((s, i) => ({
  id: 'fixture-' + i, file: 'synthetic-' + i + '.wav', opus: 'audio/' + hashes[i] + '.opus',
  title: 'Synthetic ' + i, startAt: start + s.offset, duration: s.duration, monthId: id, lyrics: [],
}));
const month = { schemaVersion: 2, id, revision: 'fixture-month', audios: tracks };
const manifest = {
  schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: now, revision: 'fixture-release',
  months: [{ id, ...bounds, count: tracks.length, revision: month.revision, key: 'months/fixture.json', available: true }],
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

const servers = [], contexts = [];
let browser, serverErrors = [];
async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}

try {
  process.env.PUBLIC_AUDIO_BASE = '';
  const { handler } = await import('../build/handler.js');
  const origin = await listen(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture.invalid');
    const json = v => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/api/current') return json({ schemaVersion: 2, releaseId: 'c'.repeat(64), key: 'releases/' + 'c'.repeat(64) + '/manifest.json' });
    if (u.pathname === '/api/catalog') return json(manifest);
    if (u.pathname.startsWith('/api/month/')) return json(month);
    if (u.pathname.startsWith('/brand/')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(png); }
    // No live API/storage media is reachable: every offline verdict below is a real cache miss.
    if (u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (!(u.pathname === '/' || u.pathname === '/service-worker.js' || u.pathname.startsWith('/_app/') || ['/favicon', '/icon', '/manifest'].some(p => u.pathname.startsWith(p)))) { res.writeHead(404); return res.end(); }
    Promise.resolve(handler(req, res)).catch(e => { serverErrors.push(e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
  }));
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });
  contexts.push(context);
  const blocked = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    if (new URL(url).origin === origin) return route.continue();
    blocked.push(url);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
  await page.getByRole('tab', { name: '泳道时间轴', exact: true }).click();
  await page.waitForSelector('[data-timeline-container] [data-track-card]');
  await page.evaluate(() => document.querySelector('[data-timeline-container]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);

  // Offline with no cached audio: every visible track resolves to the confirmed "missing" state.
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  await page.waitForFunction(() => document.querySelectorAll('[data-offline-availability="missing"]').length > 0);
  const dimmed = await page.locator('[data-track-card]').evaluateAll(cards => cards.filter(el => el.closest('[data-offline-availability]')?.dataset.offlineAvailability === 'missing').length);
  assert.ok(dimmed > 0, 'offline uncached track cards must be marked unavailable and dimmed');

  const geometry = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return {
      cards: [...document.querySelectorAll('[data-track-card]')].map(el => ({ ...rect(el), dimmed: el.closest('[data-offline-availability]')?.dataset.offlineAvailability === 'missing' })),
      strips: [...document.querySelectorAll('[role="img"][aria-label^="空白"]')].map(rect),
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
  assert.ok(geometry.cards.length > 1, 'synthetic lane must render track cards');
  assert.ok(geometry.strips.length > 0, 'compressed lane must render time-compression strips');

  const shot = async () => (await page.screenshot()).toString('base64');
  const visible = await shot();
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-track-card]')) el.style.visibility = 'hidden'; });
  const hidden = await shot();
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-track-card]')) el.style.visibility = ''; });

  const verdict = await page.evaluate(async ({ a, b, geometry }) => {
    const decode = async b64 => {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height), ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    };
    const A = await decode(a), B = await decode(b);
    const px = (img, x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    const delta = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
    const inCard = (x, pad = 0) => geometry.cards.some(c => x >= c.x - pad && x <= c.x + c.w + pad);
    let covered = null, uncovered = null;
    for (const s of geometry.strips) {
      const bandY = s.y + s.h / 2;
      for (let x = Math.ceil(s.x) + 2; x <= Math.floor(s.x + s.w) - 2; x++) {
        if (x < 2 || x > A.width - 2) continue;
        // 3px inset keeps corner rounding and edge antialiasing out of the samples.
        const card = geometry.cards.find(c => x >= c.x + 3 && x <= c.x + c.w - 3);
        const refY = card ? card.y + 3 : s.y - 4; // same card/lane row, above the strip band
        const strength = delta(px(B, x, bandY), px(B, x, refY));
        if (!(strength > 0)) continue;
        const sample = { x, bandY, refY, strength };
        if (card) {
          if (!covered || strength > covered.strength) covered = { ...sample, card, uniform: delta(px(A, x, bandY), px(A, x, refY)), hiddenDelta: delta(px(A, x, bandY), px(B, x, bandY)) };
        } else if (!inCard(x, 2) && (!uncovered || strength > uncovered.strength)) {
          uncovered = { ...sample, unchanged: delta(px(A, x, bandY), px(B, x, bandY)) };
        }
      }
    }
    return { covered, uncovered, size: { w: A.width, h: A.height }, scale: A.width / geometry.viewport.w };
  }, { a: visible, b: hidden, geometry });

  assert.equal(verdict.scale, 1, 'pixel sampling assumes deviceScaleFactor 1');
  assert.ok(verdict.covered, 'fixture must place an unavailable track card over the time-compression strip');
  assert.equal(verdict.covered.card.dimmed, true, 'the covering card must be the unavailable (dimmed) card');
  assert.ok(verdict.covered.strength >= 25, 'strip must be genuinely painted beneath the card column: ' + JSON.stringify(verdict.covered));
  assert.ok(verdict.covered.uniform <= 3, 'strip must not show through the card: sampled card column is not uniform: ' + JSON.stringify(verdict.covered));
  assert.ok(verdict.covered.hiddenDelta >= 25, 'hiding the card must reveal the strip it occluded: ' + JSON.stringify(verdict.covered));
  assert.ok(verdict.uncovered, 'strip must also be measured where no card covers it');
  assert.ok(verdict.uncovered.strength >= 25, 'strip must stay visible outside the card: ' + JSON.stringify(verdict.uncovered));
  assert.ok(verdict.uncovered.unchanged <= 2, 'card toggling must not change the strip outside the card: ' + JSON.stringify(verdict.uncovered));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(blocked, []);
  console.log('narrow strip overlap:', JSON.stringify({
    viewport: geometry.viewport, cards: geometry.cards.length, strips: geometry.strips.length,
    covered: { x: verdict.covered.x, strength: verdict.covered.strength, uniform: verdict.covered.uniform, hiddenDelta: verdict.covered.hiddenDelta },
    uncovered: { x: verdict.uncovered.x, strength: verdict.uncovered.strength, unchanged: verdict.uncovered.unchanged },
    engine: 'Chromium; not iOS',
  }));
  console.log('narrow-strip-overlap: 15 checks passed (synthetic data, offline, pixel evidence)');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
