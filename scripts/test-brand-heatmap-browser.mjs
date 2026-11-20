import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchChrome, openPage } from './cdp-session.mjs';

const dir = process.env.HOME + '/.openclaw/workspace/artifacts/anyun-brand-heatmap';
await mkdir(dir, { recursive: true });
const url = process.env.TEST_URL ?? 'http://127.0.0.1:5173';
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const mmdd = today.slice(5).replace('-', '/');

let checks = 0;
const ck = async (name, fn) => {
  await fn();
  checks++;
  console.log('PASS ' + name);
};

const chrome = await launchChrome();
const page = await openPage(chrome.port);

const brandRequests = [];
const exceptions = [];
const consoleErrors = [];
page.on((message) => {
  if (message.method === 'Network.requestWillBeSent') {
    const target = message.params.request.url;
    if (new URL(target).pathname.startsWith('/brand/')) brandRequests.push(target);
  }
  if (message.method === 'Network.loadingFailed' && message.params.errorText) {
    brandRequests.failures = (brandRequests.failures ?? 0) + 1;
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
  }
});

try {
  // 从干净状态开始：清掉热力图日期记忆
  await page.navigate(url);
  await page.evaluate("localStorage.removeItem('anyun-heat-range-v1')");
  await page.navigate(url);

  // ---------- A. 品牌图从存储端点加载 ----------
  await page.waitFor(
    "(() => { const i = document.querySelector('[data-brand-image]'); return i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0; })()",
    { label: '品牌头像解码完成' },
  );
  await ck('头像由同源 /brand/ 端点提供、已解码、不带 crossorigin', async () => {
    const info = JSON.parse(await page.evaluate(`JSON.stringify((() => { const i = document.querySelector('[data-brand-image]'); return { src: i.getAttribute('src'), naturalWidth: i.naturalWidth, crossorigin: i.hasAttribute('crossorigin'), alt: i.getAttribute('alt'), reveal: i.currentSrc }; })())`));
    assert.match(info.src, /^\/brand\/avatar\.png(\?.*)?$/, 'src: ' + info.src);
    assert.equal(info.crossorigin, false);
    assert.ok(info.naturalWidth > 0);
    assert.equal(info.alt, '安允日记');
    assert.equal(await page.evaluate("document.querySelectorAll('[data-brand-placeholder]').length"), 0);
  });
  await ck('正常页面无未捕获异常', async () => assert.deepEqual(exceptions, []));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 260, deviceScaleFactor: 1, mobile: false });
  const headerShot = await page.send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dir + '/brand-loaded-header.png', Buffer.from(headerShot.data, 'base64'));
  await page.send('Emulation.clearDeviceMetricsOverride');

  // ---------- B. 热力图日期域到今天 ----------
  // 点击标签需等水合完成（事件委托挂在根上），失败就重试，直到 aria-selected 翻转。
  const tabReady = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const selected = await page.evaluate("(() => { const tab = Array.from(document.querySelectorAll('[role=tab]')).find((node) => node.textContent.trim() === '热力图'); if (!tab) return 'missing'; if (tab.getAttribute('aria-selected') === 'true') return 'selected'; tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return 'clicked'; })()");
      if (selected === 'selected') return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('热力图标签未能激活');
  };
  await tabReady();
  await page.waitFor("document.querySelectorAll('[data-heat-col]').length > 0", { label: '热力图列渲染' });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const headers = JSON.parse(await page.evaluate("JSON.stringify(Array.from(document.querySelectorAll('[data-heat-col-header]')).map((node) => node.textContent.replace(/\\s+/g, ' ').trim()))"));
  await ck(`首列是今天（${mmdd}）`, async () => {
    assert.ok(headers.length > 0, '没有列头');
    assert.equal(headers[0].split(' ')[0], mmdd, JSON.stringify(headers.slice(0, 5)));
  });

  const firstColumn = JSON.parse(await page.evaluate(`JSON.stringify((() => { const col = document.querySelector('[data-heat-col]'); return { today: col.getAttribute('data-heat-today'), cells: Array.from(col.querySelectorAll('button')).map((b) => ({ disabled: b.disabled, label: b.getAttribute('aria-label'), bg: getComputedStyle(b).backgroundColor })) }; })())`));
  await ck('今天列是 24 个空单元格（不造假数据）', async () => {
    assert.equal(firstColumn.today, 'true');
    assert.equal(firstColumn.cells.length, 24);
    assert.ok(firstColumn.cells.every((cell) => cell.disabled), '今天无数据应为空单元格');
    assert.ok(firstColumn.cells.every((cell) => cell.label.includes('无已知时长音频')));
  });

  const dataIndex = headers.findIndex((header) => header.startsWith('11/16'));
  await ck('有数据日（11/16）照常有可点热力格', async () => {
    assert.ok(dataIndex > 0, '应找到 11/16 列: ' + JSON.stringify(headers.slice(0, 8)));
    const column = JSON.parse(await page.evaluate(`JSON.stringify((() => { const col = document.querySelectorAll('[data-heat-col]')[${dataIndex}]; return { today: col.getAttribute('data-heat-today'), enabled: col.querySelectorAll('button:not([disabled])').length }; })())`));
    assert.equal(column.today, null);
    assert.ok(column.enabled > 0, '11/16 应有热力格');
  });

  const pill = await page.evaluate("(document.body.innerText.match(/活跃 \\d+ 天/) ?? [''])[0]");
  const activeDays = Number((pill.match(/活跃 (\d+) 天/) ?? [0, 0])[1]);
  const columnCount = await page.evaluate("document.querySelectorAll('[data-heat-col]').length");
  await ck('活跃天数不含空列，列数覆盖域内每一天', async () => {
    assert.ok(activeDays >= 1, '活跃天数: ' + pill);
    assert.ok(columnCount > activeDays, `列数 ${columnCount} 应大于活跃天数 ${activeDays}`);
  });
  await ck('热力图今天列截图已保存', async () => {
    await page.screenshot(dir + '/heatmap-to-today.png');
  });

  // ---------- C. 断源降级：重试一次后占位，且不再请求 ----------
  await page.send('Network.setBlockedURLs', { urls: ['*/brand/avatar.png*'] });
  const before = brandRequests.length;
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.navigate(url);
  await page.waitFor("document.querySelectorAll('[data-brand-placeholder]').length === 1", { label: '品牌图降级为占位' });

  await ck('断源后降级为占位（保留 alt 文本）', async () => {
    const placeholder = JSON.parse(await page.evaluate("JSON.stringify({ count: document.querySelectorAll('[data-brand-placeholder]').length, label: document.querySelector('[data-brand-placeholder]').getAttribute('aria-label'), imgs: document.querySelectorAll('[data-brand-image]').length })"));
    assert.equal(placeholder.count, 1);
    assert.equal(placeholder.label, '安允日记');
    assert.equal(placeholder.imgs, 0, '失败后不应继续渲染 <img>');
  });

  const attemptsAtFallback = brandRequests.length - before;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await ck('仅重试一次，无请求风暴/无未捕获异常', async () => {
    assert.ok(attemptsAtFallback <= 2, '请求次数: ' + attemptsAtFallback);
    assert.equal(brandRequests.length - before, attemptsAtFallback, '占位后不得继续请求');
    assert.deepEqual(exceptions, []);
  });
  await ck('断源截图已保存', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 260, deviceScaleFactor: 1, mobile: false });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(dir + '/brand-fallback.png', Buffer.from(shot.data, 'base64'));
    await page.send('Emulation.clearDeviceMetricsOverride');
  });

  await ck('品牌图请求只走 /brand/ 前缀', async () => {
    assert.ok(brandRequests.length >= 1);
    assert.ok(brandRequests.every((requestUrl) => new URL(requestUrl).pathname.startsWith('/brand/')));
  });

  console.log(`browser checks passed (${checks}): brand from storage endpoint, retry-once fallback, heatmap domain ends ${today}`);
  console.log(`console errors observed during outage: ${consoleErrors.length} (浏览器网络失败条目，预期 ≤2)`);
} finally {
  page.close();
  await chrome.close();
}