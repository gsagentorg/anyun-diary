/**
 * 品牌图（头像 / 封面）运行时基址解析。
 *
 * 品牌图不再打包进构建产物：页面按运行时基址拼 URL，由同源 `/brand/<file>` 路由
 * 或显式 `PUBLIC_BRAND_BASE`（CDN / 对象存储）提供。
 *
 * 优先级：
 *   1. `PUBLIC_BRAND_BASE` 显式指定（绝对 http(s) URL 或同源路径）
 *   2. 数据后端基址同源 → `<数据后端基址>/brand/`（原生 App 用已配置后端）
 *   3. 同源 `/brand/` 兜底
 *
 * 本模块是纯函数集合（不读 `$env`、不引 Svelte 运行时），便于直接单测。
 */

export const BRAND_FILES = ['avatar.png', 'cover.jpg'] as const;
export type BrandFile = (typeof BRAND_FILES)[number];

/** 首次加载 + 失败重试一次；达到即降级为占位。 */
export const BRAND_MAX_ATTEMPTS = 2;

export function isBrandFile(file: string): file is BrandFile {
  return (BRAND_FILES as readonly string[]).includes(file);
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : value + '/';
}

/**
 * 把候选基址规范成「以 / 结尾」的可用基址；不合法返回 null。
 * 只接受：绝对 http(s) URL，或以单个 `/` 开头的同源路径。
 * 拒绝协议相对（`//host`）、相对路径、查询串/hash、URL 内嵌凭据。
 */
export function normalizeBrandBase(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (raw.startsWith('//')) return null;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return withTrailingSlash(url.href);
  }
  if (raw.startsWith('/')) {
    if (raw.includes('?') || raw.includes('#')) return null;
    return withTrailingSlash(raw);
  }
  return null;
}

/** 解析品牌基址：显式 > 数据后端同源 > 同源兜底。 */
export function resolveBrandBase(explicit?: string | null, dataBase?: string | null): string {
  const explicitBase = normalizeBrandBase(explicit);
  if (explicitBase) return explicitBase;
  const data = normalizeBrandBase(dataBase);
  if (data) return data + 'brand/';
  return '/brand/';
}

/** 拼接单个品牌图 URL；文件名必须在白名单内。 */
export function brandAssetUrl(base: string, file: string): string {
  if (!isBrandFile(file)) throw new Error('Unknown brand asset: ' + file);
  const normalized = normalizeBrandBase(base) ?? '/brand/';
  return normalized + file;
}

/**
 * 第 N 次尝试的 URL：0 = 原地址；重试附一次性查询参数，绕开浏览器/缓存层对
 * 失败响应的负缓存（不改变服务端语义，`/brand/` 路由忽略查询串）。
 */
export function brandAttemptSrc(src: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt <= 0) return src;
  const separator = src.includes('?') ? '&' : '?';
  return src + separator + 'retry=' + attempt;
}

/** 是否已用尽尝试（应降级为占位，不再发起请求，避免报错风暴）。 */
export function brandExhausted(attempt: number): boolean {
  return Number.isFinite(attempt) && attempt >= BRAND_MAX_ATTEMPTS;
}