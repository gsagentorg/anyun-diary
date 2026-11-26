/// <reference lib="webworker" />
/**
 * 应用 shell 的 Service Worker（仅 web 构建；注册点见 src/routes/+layout.svelte：
 * https/localhost、非 dev、非 Capacitor，并需 svelte.config.js 设 kit.serviceWorker.register=false
 * 关掉默认自动注册；App 内离线由 Swift 原生缓存负责）。
 *
 * 边界（docs/web-offline-cache.md）：
 * - 只预缓存构建产物（含动态 import 的 JS/CSS chunks）与 static 里的少量图标类资源；
 *   真实音频（/api/audio、static audio/）、品牌数据（brand/、native-lyrics.json、design-variants.html）一律不预缓存。
 * - 同源导航请求（页面重开）走网络优先，成功后保存快照；离线时用最近快照兜底 → 支持离线重开应用。
 * - /api/**、/brand/**、/audio/** 完全不拦截：音频字节只归 web-audio-cache.ts（CacheStorage+Blob）管。
 * - 缓存命名空间按 version 隔离；activate 只清自己的旧 shell/nav 缓存，绝不碰 anyun-web-audio-v1。
 * - 更新等待旧页面关闭后激活，不强刷页面，也不提前删除旧页面依赖的资源。
 */
import { build, files, version } from '$service-worker';

const SHELL_CACHE = `anyun-shell-${version}`;
const NAV_CACHE = `anyun-nav-${version}`;
const OWN_PREFIXES = ['anyun-shell-', 'anyun-nav-'];
const NAV_MAX = 8;
const worker = self as unknown as ServiceWorkerGlobalScope;

/** static 里只带图标/图片类资源进 precache；数据与音频排除。 */
const ICONISH = /\.(?:ico|png|svg|webp|avif|jpe?g|gif|woff2?)$/i;
const isDataStatic = (f: string) => /^(?:audio|brand)\//.test(f.replace(/^\/+/, '')) || /\.(?:opus|ogg|oga|mp3|m4a|aac|json|html)$/i.test(f);
const assets = [...build, ...files.filter((f) => ICONISH.test(f) && !isDataStatic(f))];
const assetPaths = new Set(assets.map((p) => new URL(p, worker.location.href).pathname));

worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(assets.map((asset) => cache.add(new Request(asset, { cache: 'default' }))));
      // First installation happens after navigation: explicitly seed the entry page.
      const home = new URL('./', worker.location.href);
      const response = await fetch(home, {cache: 'reload'});
      if (!response.ok) throw Error('Offline entry page unavailable');
      await (await caches.open(NAV_CACHE)).put(home, response);
      // Do not skipWaiting: an open tab may still need its previous version's chunks.
    })(),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 只清自己的旧命名空间；音频缓存（anyun-web-audio-v1）与其他数据一律不动。
      for (const name of await caches.keys()) {
        if (OWN_PREFIXES.some((prefix) => name.startsWith(prefix)) && name !== SHELL_CACHE && name !== NAV_CACHE) {
          await caches.delete(name);
        }
      }
      await worker.clients.claim();
    })(),
  );
});

async function offlineFallback(request: Request): Promise<Response> {
  const nav = await caches.open(NAV_CACHE);
  const exact = await nav.match(request);
  if (exact) return exact;
  const home = await nav.match('/', { ignoreSearch: true });
  if (home) return home;
  return new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安允日记 · 离线</title><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center"><p>网络不可用，且本页尚无离线快照。</p><p>重新联网后打开一次本页面即可保存离线版本。</p>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return;
  // 音频与数据端点绝不拦截：离线音频由 web-audio-cache 的 Blob URL 承担。
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/brand/') || url.pathname.startsWith('/audio/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const nav = await caches.open(NAV_CACHE);
            await nav.put(request, response.clone());
            const keys = await nav.keys();
            for (const key of keys.slice(0, Math.max(0, keys.length - NAV_MAX))) await nav.delete(key);
          }
          return response;
        } catch {
          return offlineFallback(request);
        }
      })(),
    );
    return;
  }

  if (assetPaths.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const shell = await caches.open(SHELL_CACHE);
        const cached = await shell.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok && assetPaths.has(url.pathname)) await shell.put(request, response.clone());
          return response;
        } catch {
          return new Response(null, { status: 504 });
        }
      })(),
    );
  }
  // 其余请求不拦截。
});
