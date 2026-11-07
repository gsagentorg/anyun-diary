import { Capacitor } from '@capacitor/core';
import { env as _env } from '$env/dynamic/public';
import bundledData from '$lib/data.json';
import type { Recording } from './types';

/**
 * 后端地址：索引 `${base}/data.json` 与切片音频 `${base}/audio/<文件名>` 都从这里拉。
 * - 运行时可配仅限原生壳（App）：首启无后端时弹窗收集（BackendSheet），存 localStorage 覆盖构建期默认；
 *   远程索引拉取也仅在 App 内发生
 * - web 恒用构建期注入的 PUBLIC_AUDIO_BASE（留空同源 /audio），索引恒用内置 data.json，
 *   不可运行时配置，行为与改造前完全一致
 */

const KEY = 'anyun-backend-v1';

const BUILD_BASE = (((_env && _env.PUBLIC_AUDIO_BASE) as string | undefined) ?? '').replace(/\/+$/, '');

export const backend = $state<{ base: string; prompt: boolean; recordings: Recording[] | null }>({
  base: BUILD_BASE,
  prompt: false,
  recordings: null,
});

/** 缺字段的录像（未导出切片/无时长）补空数组，避免组件里 undefined.length */
function normalizeRecordings(raw: unknown[]): Recording[] {
  return (raw as Recording[]).map((r) => ({
    ...r,
    duration: r.duration ?? null,
    segments: r.segments ?? [],
    clips: r.clips ?? [],
  }));
}

/** 内置索引（构建时打进包）：首屏渲染（含预渲染）+ 远程拉取失败时的兜底 */
export const bundledRecordings: Recording[] = normalizeRecordings(
  (bundledData as { recordings: unknown[] }).recordings,
);

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

/** 拉取远程索引并整体替换；失败静默保留现有数据（内置兜底或上次成功结果）。
 * 仅原生壳内拉取：web 保持旧行为（不发这个请求，索引永远用内置 data.json） */
export async function fetchIndex(): Promise<void> {
  if (!isNativeApp() || !backend.base) return;
  const seq = ++fetchSeq;
  try {
    const res = await fetch(`${backend.base}/data.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { recordings?: unknown };
    if (!Array.isArray(json.recordings)) throw new Error('索引格式不符');
    const recs = normalizeRecordings(json.recordings);
    if (seq === fetchSeq) backend.recordings = recs;
  } catch {
    /* 拉取失败不致命：继续用内置/上次数据 */
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
