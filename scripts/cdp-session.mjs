// 极简 CDP 客户端：本机 playwright-core 副本的 selector 引擎不可用（Node 26 实测 locator 恒为 0），
// 浏览器验收改走原生 CDP（Node 内置 WebSocket / fetch），无额外依赖。
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error('Chrome 未在超时内暴露 DevTools 端口');
      await sleep(100);
    }
  }
}

export async function launchChrome({ executablePath = process.env.CHROMIUM_PATH, width = 1440, height = 900 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'cdp-profile-'));
  const child = spawn(executablePath ?? 'chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const ports = await waitForFile(join(profile, 'DevToolsActivePort'), 20000);
  const port = Number(ports.split('\n')[0]);
  const browserWs = `ws://127.0.0.1:${port}${ports.split('\n')[1].trim()}`;
  return {
    port,
    browserWs,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      if (stderr.includes('FATAL')) console.error(stderr.slice(0, 500));
    },
  };
}

export async function openPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page');
  // Node 内置 WebSocket(undici) 与 Chrome 157 握手失败；用 ws（可用 WS_MODULE 指定绝对路径）。
  let WS;
  try {
    ({ default: WS } = await import(process.env.WS_MODULE ?? 'ws'));
  } catch {
    throw new Error('缺少 ws 模块：设置 WS_MODULE 指向可用的 ws 包（本仓库不内置浏览器依赖）');
  }
  const ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (error) => reject(new Error('CDP 连接失败: ' + error.message)));
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const on = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('页面脚本异常: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result.value;
  };

  const waitFor = async (expression, { timeout = 60000, label = expression } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() > deadline) throw new Error('等待超时: ' + label);
      await sleep(150);
    }
  };

  const navigate = async (url, { timeout = 60000 } = {}) => {
    const loaded = new Promise((resolve) => {
      const off = on((message) => {
        if (message.method === 'Page.loadEventFired') {
          off();
          resolve();
        }
      });
    });
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(timeout).then(() => { throw new Error('页面加载超时: ' + url); })]);
  };

  const screenshot = async (path) => {
    const { writeFile } = await import('node:fs/promises');
    const original = await send('Page.getLayoutMetrics');
    const size = original.cssContentSize ?? original.contentSize;
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: Math.max(600, Math.ceil(size.height)),
      deviceScaleFactor: 1,
      mobile: false,
    });
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await send('Emulation.clearDeviceMetricsOverride');
    await writeFile(path, Buffer.from(shot.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  return { send, on, evaluate, waitFor, navigate, screenshot, close: () => ws.close() };
}