/**
 * 浏览器/App 内的品牌图基址：读 `$env/dynamic/public` 与当前数据后端基址。
 *
 * 原生 App（Capacitor）里数据后端基址由用户在运行时选择，品牌图必须跟着走同一源，
 * 因此这里返回函数而不是模块常量——模板中调用时 Svelte 会跟踪 `backend.base` 的读取。
 */
import { env } from '$env/dynamic/public';
import { apiBase } from './backend.svelte';
import { brandAssetUrl, resolveBrandBase, type BrandFile } from './brand';

export function currentBrandBase(): string {
  const explicit = (env as unknown as Record<string, string | undefined>)?.PUBLIC_BRAND_BASE;
  return resolveBrandBase(explicit, apiBase());
}

export function brandSrc(file: BrandFile): string {
  return brandAssetUrl(currentBrandBase(), file);
}