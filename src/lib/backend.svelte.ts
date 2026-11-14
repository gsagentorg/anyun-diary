import { Capacitor } from '@capacitor/core';
import { env as _env } from '$env/dynamic/public';
import { validateCatalog } from './catalog-schema.js';
import type { Recording } from './types';

/** Native runtime backend; web requests remain same-origin. */
const KEY = 'anyun-backend-v1';

const BUILD_BASE = (((_env && _env.PUBLIC_AUDIO_BASE) as string | undefined) ?? '').replace(/\/+$/, '');

export const backend = $state<{ base: string; prompt: boolean; recordings: Recording[] | null; error: string }>({
  base: BUILD_BASE,
  prompt: false,
  recordings: null,
  error: '',
});

/** 是否运行在 Capacitor 原生壳里（iOS App） */
export function isNativeApp(): boolean {
  return typeof window !== 'undefined' && Capacitor.isNativePlatform();
}

/** 保存后端地址（仅 App：web 无入口，此处再兑一道门） */
export function saveBackendBase(url: string): void {
  if (!isNativeApp()) return;
  const base = url.trim().replace(/\/+$/, '');
  backend.base = base;
  backend.prompt = false;
  try {
    if (base) localStorage.setItem(KEY, base);
    else localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式写失败不致命 */
  }
  fetchIndex();
}

export function dismissBackendPrompt(): void {
  backend.prompt = false;
}

let fetchSeq = 0;

/** Failed refreshes retain the last successful validated snapshot. */
export async function fetchIndex(): Promise<void> {
  const seq = ++fetchSeq;
  if (isNativeApp() && !backend.base) return;
  const base = isNativeApp() ? backend.base : '';
  try {
    const res = await fetch(base + '/api/catalog', { cache: 'no-store' });
    if (!res.ok) throw new Error('catalog unavailable');
    const catalog = validateCatalog(await res.json());
    if (seq === fetchSeq) {
      backend.recordings = catalog.recordings;
      backend.error = '';
    }
  } catch {
    if (seq === fetchSeq) backend.error = '目录加载失败；保留上次目录，将自动重试。';
  }
}

/** 启动入口（+layout 顶层调用）。运行时可配仅限原生壳：web 恒用构建期默认，零副作用 */
export function initBackend(): void {
  if (typeof window === 'undefined' || !isNativeApp()) return;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) backend.base = saved.replace(/\/+$/, '');
  } catch {
    /* localStorage 不可用则用构建期默认 */
  }
  if (!backend.base) backend.prompt = true;
  fetchIndex();
}
