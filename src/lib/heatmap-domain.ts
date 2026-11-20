/**
 * 热力图日期域计算（纯函数，便于单测）。
 *
 * 业务口径：Asia/Shanghai 日界；域始终渲染到今天为止，域内无数据日保留为空列，
 * 既不跳过也不补假数据。历史/月块加载逻辑不在此模块内。
 */
import { shDayStart } from './playlist-core';

export const DAY_SECONDS = 86400;

/** 可复用的「今天」口径：按上海日界归一。 */
export function todayStart(now: number = Date.now() / 1000): number {
  return shDayStart(now);
}

/**
 * 活动日（通常来自已加载音频，可乱序/重复）→ 展示用日期列（降序）。
 *
 * - 至少一个活动日时，域尾 = max(今天, 最新活动日)，随后逐日下推到最早活动日；
 * - `end`（用户选的结束日期）只用来把域尾往回夹，不会越过今天；
 * - 没有活动日时返回空数组（调用方保留「无数据」提示，不渲染空月）。
 */
export function heatDomainDays(
  activeDays: number[],
  { today, end = null }: { today: number; end?: number | null },
): number[] {
  const days = [...new Set(activeDays.filter((day) => Number.isFinite(day)))].sort((a, b) => b - a);
  if (!days.length) return [];
  const todayDay = shDayStart(today);
  const requestedEnd = end == null || !Number.isFinite(end) ? todayDay : Math.min(shDayStart(end), todayDay);
  const stop = Math.max(requestedEnd, days[0]);
  const oldest = days[days.length - 1];
  const out: number[] = [];
  for (let day = stop; day >= oldest; day -= DAY_SECONDS) out.push(day);
  return out;
}

/** 域内「有数据」的天（用于活跃天数等统计，避免把尾部空列算成活跃）。 */
export function heatActiveDayCount(activeDays: number[]): number {
  return new Set(activeDays.filter((day) => Number.isFinite(day))).size;
}