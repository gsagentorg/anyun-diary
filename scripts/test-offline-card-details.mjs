/** Issue #14: confirmed-unavailable track cards get a dashed outline (unknown/cached must not),
 * track details are grouped into labelled rows instead of one dot-separated string, and the same
 * details are reachable on touch via long-press without hijacking tap-to-play.
 * Synthetic data, offline, Chromium only; desktop + narrow viewports, compress + linear lanes. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { monthBounds, monthIdAt } from '../src/lib/month.js';

const { PLAYWRIGHT_MODULE, CHROMIUM_PATH } = process.env;
if (!PLAYWRIGHT_MODULE || !CHROMIUM_PATH) throw Error('Set PLAYWRIGHT_MODULE and CHROMIUM_PATH; missing browser is a failure, not a skip');
const { chromium } = await import(PLAYWRIGHT_MODULE);

const now = Math.floor(Date.now() / 1000);
const today = Math.floor((now + 28800) / 86400) * 86400 - 28800;
const start = today - 2 * 86400 + 12 * 3600;
const id = monthIdAt(start), bounds = monthBounds(id);
const CACHED_HASH = 'c'.repeat(64), MISSING_HASH = 'd'.repeat(64);
// The unknown track deliberately uses a path outside the /api/audio/<64 hex>.opus shape: the
// web cache key normalizer rejects it, so the availability query cannot reach a verdict and the
// row must stay "unknown" instead of being reported as a confirmed miss.
const UNKNOWN_OPUS = 'audio/unknown-state.opus';
const fixtures = [
  { title: '缓存曲目', opus: 'audio/' + CACHED_HASH + '.opus', offset: 0 },
  { title: '缺失曲目', opus: 'audio/' + MISSING_HASH + '.opus', offset: 600 },
  { title: '未知曲目', opus: UNKNOWN_OPUS, offset: 1200 },
];
const tracks = fixtures.map((f, i) => ({
  id: 'fixture-' + i, file: 'synthetic-' + i + '.wav', opus: f.opus, title: f.title,
  startAt: start + f.offset, duration: 60, monthId: id, lyrics: [],
}));
const month = { schemaVersion: 2, id, revision: 'fixture-month', audios: tracks };
const manifest = {
  schemaVersion: 2, timezone: 'Asia/Shanghai', generatedAt: now, revision: 'fixture-release',
  months: [{ id, ...bounds, count: tracks.length, revision: month.revision, key: 'months/fixture.json', available: true }],
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

const cases = [
  { name: 'desktop-compress', width: 1280, height: 900, lane: 'compress', touch: false },
  { name: 'desktop-linear', width: 1280, height: 900, lane: 'linear', touch: false },
  { name: 'narrow-compress', width: 390, height: 844, lane: 'compress', touch: true },
  { name: 'narrow-linear', width: 390, height: 844, lane: 'linear', touch: true },
];

let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }
const servers = [], contexts = [];
let browser, serverErrors = [], blocked = [];
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
    if (u.pathname === '/api/current') return json({ schemaVersion: 2, releaseId: 'e'.repeat(64), key: 'releases/' + 'e'.repeat(64) + '/manifest.json' });
    if (u.pathname === '/api/catalog') return json(manifest);
    if (u.pathname.startsWith('/api/month/')) return json(month);
    if (u.pathname.startsWith('/brand/')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(png); }
    // No live audio is reachable: every verdict below is a real cache state, never a download.
    if (u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (!(u.pathname === '/' || u.pathname === '/service-worker.js' || u.pathname.startsWith('/_app/') || ['/favicon', '/icon', '/manifest'].some(p => u.pathname.startsWith(p)))) { res.writeHead(404); return res.end(); }
    Promise.resolve(handler(req, res)).catch(e => { serverErrors.push(e.message); if (!res.headersSent) res.writeHead(500); res.end(); });
  }));
  browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

  const stateLocator = (page, state) => page.locator('[data-offline-availability="' + state + '"]').first();
  const surfaceOf = (outer, lane) => lane === 'compress' ? outer.locator('[data-track-card]') : outer;
  async function panelInfo(page) {
    return page.locator('[data-track-details]').evaluate(el => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        source: el.getAttribute('data-details-source'),
        role: el.getAttribute('role'),
        pointerEvents: getComputedStyle(el).pointerEvents,
        rect: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width },
        keys: [...el.querySelectorAll('[data-detail-key]')].map(n => n.getAttribute('data-detail-key')),
        labels: [...el.querySelectorAll('dt')].map(n => (n.textContent ?? '').trim()),
        values: Object.fromEntries([...el.querySelectorAll('dd')].map(n => [n.getAttribute('data-detail-key'), (n.textContent ?? '').trim()])),
        title: (el.querySelector('[data-detail-key="title"]')?.textContent ?? '').trim(),
        text,
      };
    });
  }

  for (const spec of cases) {
    const context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1,
      serviceWorkers: 'block', timezoneId: 'Asia/Shanghai', hasTouch: spec.touch,
    });
    contexts.push(context);
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
    const url = origin + '/' + (spec.lane === 'linear' ? '?lane=linear' : '');
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-continuous-browse][data-cached-months="1"]');
    await page.getByRole('tab', { name: '泳道时间轴', exact: true }).click();
    await page.waitForSelector('[data-timeline-container] [role="button"]');
    ok(await page.evaluate(() => window.isSecureContext), spec.name + ': Cache API needs a secure context');

    // Seed one complete cached entry: the only sanctioned way to reach the "cached" state here.
    await page.evaluate(async ({ key }) => {
      const cache = await caches.open('anyun-web-audio-v1');
      const body = new Uint8Array(2048);
      await cache.put(key, new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'x-anyun-bytes': '2048', 'x-anyun-stored-at': String(Date.now()) },
      }));
    }, { key: origin + '/api/audio/' + CACHED_HASH + '.opus' });

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.waitForFunction(() => ['cached', 'missing', 'unknown'].every(s => document.querySelector('[data-offline-availability="' + s + '"]')));
    ok(true, spec.name + ': cached / missing / unknown all rendered');

    // ---- Visual contract: dashed outline only for the confirmed miss ----
    await page.waitForTimeout(300); // let the opacity transition settle before sampling
    const looks = {};
    for (const state of ['cached', 'missing', 'unknown']) {
      const outer = stateLocator(page, state);
      ok(await outer.count() > 0, spec.name + ': ' + state + ' row present');
      const surface = surfaceOf(outer, spec.lane);
      looks[state] = await surface.evaluate(el => {
        const s = getComputedStyle(el);
        return {
          outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor,
          opacity: s.opacity, className: el.className,
          wash: getComputedStyle(el, '::after').content,
          titleAttr: el.closest('[data-offline-availability]')?.getAttribute('title') ?? el.getAttribute('title') ?? '',
        };
      });
    }
    ok(looks.missing.outlineStyle === 'dashed', spec.name + ': missing card has a dashed outline: ' + JSON.stringify(looks.missing));
    ok(looks.missing.outlineWidth === '1px', spec.name + ': dashed outline is 1px');
    ok(looks.missing.className.includes('offline-missing'), spec.name + ': missing surface carries the offline-missing class');
    ok(looks.cached.outlineStyle === 'none', spec.name + ': cached card keeps no outline (visual no-change): ' + JSON.stringify(looks.cached));
    ok(looks.unknown.outlineStyle === 'none', spec.name + ': unknown card must not imply unavailable (no outline): ' + JSON.stringify(looks.unknown));
    ok(!looks.cached.className.includes('offline-missing') && !looks.unknown.className.includes('offline-missing'), spec.name + ': only confirmed miss is dimmed');
    if (spec.lane === 'compress') {
      ok(looks.missing.wash !== 'none', spec.name + ': issue #10 opaque-card wash is still present on the missing card');
      ok(looks.cached.wash === 'none' && looks.unknown.wash === 'none', spec.name + ': wash only applies to the confirmed miss');
      ok(looks.missing.opacity === '1', spec.name + ': missing compress card stays opaque (issue #10)');
    } else {
      ok(Number(looks.missing.opacity) <= 0.6, spec.name + ': linear missing block keeps the subdued opacity: ' + looks.missing.opacity);
    }
    // Grouped lines in the native title attribute (no single dot-separated string).
    ok(looks.missing.titleAttr.includes('\n时间 ') && looks.missing.titleAttr.includes('\n时长 '), spec.name + ': title attribute is grouped on separate lines: ' + JSON.stringify(looks.missing.titleAttr));
    ok(!looks.missing.titleAttr.includes(' · 时间'), spec.name + ': title no longer dot-separates fields');

    // ---- Pointer details ----
    const missingOuter = stateLocator(page, 'missing');
    await missingOuter.scrollIntoViewIfNeeded();
    const missingBox = await surfaceOf(missingOuter, spec.lane).boundingBox();
    ok(!!missingBox, spec.name + ': missing card has a box');
    await page.mouse.move(missingBox.x + missingBox.width / 2, missingBox.y + missingBox.height / 2);
    await page.waitForSelector('[data-track-details]');
    ok(true, spec.name + ': hover opens the details panel');
    let info = await panelInfo(page);
    ok(info.source === 'pointer' && info.role === 'tooltip', spec.name + ': hover panel is a pointer tooltip: ' + JSON.stringify({ source: info.source, role: info.role }));
    ok(info.pointerEvents === 'none', spec.name + ': hover tooltip must not swallow pointer events');
    ok(info.title === '缺失曲目', spec.name + ': panel shows the track title as its own line: ' + info.title);
    ok(info.labels.includes('时间') && info.labels.includes('时长') && info.labels.includes('离线'), spec.name + ': fields carry semantic labels: ' + JSON.stringify(info.labels));
    ok(info.labels.length === new Set(info.labels).size, spec.name + ': each labelled row is rendered once');
    ok(/^\d{2}:\d{2}–\d{2}:\d{2}$/.test(info.values.time ?? ''), spec.name + ': time row is its own labelled line: ' + info.values.time);
    ok(/^\d+(?:\.\d+)?(?:s|min|h)$/.test(info.values.duration ?? ''), spec.name + ': duration row is its own labelled line: ' + info.values.duration);
    ok((info.values.offline ?? '').includes('未完整缓存'), spec.name + ': confirmed miss says so explicitly: ' + info.values.offline);
    ok(info.rect.x >= 0 && info.rect.y >= 0 && info.rect.right <= spec.width + 0.5 && info.rect.bottom <= spec.height + 0.5, spec.name + ': hover panel stays inside the viewport: ' + JSON.stringify(info.rect));

    // Hovering cached / unknown must not claim a miss.
    for (const [state, expectText, forbid] of [['cached', '已完整缓存', '未完整缓存'], ['unknown', '未知', '未完整缓存']]) {
      await page.mouse.move(2, 2);
      await page.waitForSelector('[data-track-details]', { state: 'detached' });
      const outer = stateLocator(page, state);
      await outer.scrollIntoViewIfNeeded();
      const box = await surfaceOf(outer, spec.lane).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('[data-track-details]');
      const row = await panelInfo(page);
      ok((row.values.offline ?? '').includes(expectText), spec.name + ': ' + state + ' details say " ' + expectText + ' ": ' + row.values.offline);
      ok(!(row.values.offline ?? '').includes(forbid), spec.name + ': ' + state + ' details never claim a confirmed miss');
    }
    await page.mouse.move(2, 2);
    await page.waitForSelector('[data-track-details]', { state: 'detached' });
    ok(true, spec.name + ': hover panel closes when the pointer leaves');

    // ---- Touch details: long-press opens the pinned panel, tap keeps playing ----
    const touchTarget = stateLocator(page, 'missing');
    await touchTarget.scrollIntoViewIfNeeded();
    const tbox = await touchTarget.boundingBox();
    const tapX = tbox.x + tbox.width / 2, tapY = tbox.y + tbox.height / 2;
    const pointerInit = { pointerType: 'touch', pointerId: 11, isPrimary: true, clientX: tapX, clientY: tapY, bubbles: true };
    await touchTarget.dispatchEvent('pointerdown', pointerInit);
    await page.waitForTimeout(700); // exceed the 420ms long-press threshold
    await page.waitForSelector('[data-track-details]');
    info = await panelInfo(page);
    ok(info.source === 'touch' && info.role === 'dialog', spec.name + ': long-press opens the pinned touch panel: ' + JSON.stringify({ source: info.source, role: info.role }));
    ok(info.labels.includes('时间') && info.labels.includes('时长') && info.labels.includes('离线'), spec.name + ': touch panel keeps the labelled grouping');
    ok(info.title === '缺失曲目', spec.name + ': touch panel shows the same title line');
    ok(info.pointerEvents !== 'none', spec.name + ': pinned panel is interactive (close button reachable)');
    ok(info.rect.x >= 0 && info.rect.right <= spec.width + 0.5, spec.name + ': touch panel stays inside the narrow viewport: ' + JSON.stringify(info.rect));
    // The pointer-up/click that ends a long press must not start playback.
    await touchTarget.dispatchEvent('pointerup', { ...pointerInit });
    await touchTarget.dispatchEvent('click', { bubbles: true });
    await page.waitForTimeout(100);
    ok(await page.locator('[data-track-details]').count() === 1, spec.name + ': the click ending a long press does not dismiss or hijack the panel');
    await page.getByRole('button', { name: '关闭曲目详情', exact: true }).click();
    await page.waitForSelector('[data-track-details]', { state: 'detached' });
    ok(true, spec.name + ': touch panel has an explicit close affordance');

    // A short tap still reaches the play handler (click delivered, no details panel).
    await page.evaluate(() => {
      window.__clickProbe = 0;
      const card = document.querySelector('[data-offline-availability="missing"]');
      card.addEventListener('click', () => { window.__clickProbe++; }, true);
    });
    if (spec.touch) await page.touchscreen.tap(tapX, tapY);
    else await page.mouse.click(tapX, tapY);
    await page.waitForTimeout(700);
    ok(await page.locator('[data-track-details]').count() === 0, spec.name + ': a short tap does not leave a details panel open');
    ok(await page.evaluate(() => window.__clickProbe) === 1, spec.name + ': a short tap still delivers the click to the play handler');

    ok(pageErrors.length === 0, spec.name + ': no page errors: ' + JSON.stringify(pageErrors));
    await context.close();
    console.log(JSON.stringify({ case: spec.name, viewport: spec.width + 'x' + spec.height, lane: spec.lane, touch: spec.touch, looks: Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, { outline: v.outlineStyle, wash: v.wash === 'none' ? 'none' : 'present' }])) }));
  }

  assert.deepEqual(serverErrors, []);
  assert.deepEqual(blocked, []);
  console.log('offline-card-details: ' + checks + ' checks passed (synthetic data, offline, Chromium; not iOS)');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
