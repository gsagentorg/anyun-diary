/** Relative gain, not system volume. Curves are defined in dB for predictable fading. */
export const SLEEP_MODES = [
  { id: 'gentle', label: '柔和渐隐', description: '轻轻起步，中段变轻，最后柔和收尾。' },
  { id: 'steady', label: '匀速渐隐', description: '全程按相同分贝速度，稳定地变轻。' },
  { id: 'companion', label: '轻声陪伴', description: '前段降到轻声，留下较长的微弱尾声。' },
  { id: 'late', label: '先听后睡', description: '前 2/3 时间正常听，最后 1/3 柔和渐隐。' },
  { id: 'off', label: '到时停止（不渐弱）', description: '保持原音量，到时间直接暂停。' },
] as const;
export type SleepMode = (typeof SLEEP_MODES)[number]['id'];
export function isSleepMode(value: unknown): value is SleepMode {
  return SLEEP_MODES.some((mode) => mode.id === value);
}
const smooth = (x: number) => x * x * (3 - 2 * x);
export function sleepGain(mode: SleepMode, progress: number): number {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (mode === 'off') return 1;
  if (t >= 1) return 0;
  let depth: number;
  if (mode === 'steady') depth = t;
  else if (mode === 'companion') {
    // Reach -18 dB at 25%, then spend the rest of the time fading the quiet tail.
    depth = t < 0.25 ? 0.3 * smooth(t / 0.25) : 0.3 + 0.7 * smooth((t - 0.25) / 0.75);
  } else if (mode === 'late') depth = smooth(Math.max(0, (t - 2 / 3) * 3));
  else depth = smooth(t);
  const gain = Math.pow(10, (-60 * depth) / 20);
  // The last 2% closes the -60 dB tail to true zero, not an abrupt tiny step.
  return gain * (t > 0.98 ? 1 - smooth((t - 0.98) / 0.02) : 1);
}
/** Shared coordinates keep the moving marker exactly on the plotted dB curve. */
export function sleepCurvePoint(mode: SleepMode, progress: number) {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const gain = sleepGain(mode, t);
  const height = gain <= 0 ? 0 : Math.max(0, 1 + 20 * Math.log10(gain) / 60);
  return { x: 180 * t, y: Number((38 - 34 * height).toFixed(2)) };
}
export function sleepCurvePath(mode: SleepMode): string {
  return Array.from({ length: 61 }, (_, i) => {
    const point = sleepCurvePoint(mode, i / 60);
    return `${i ? 'L' : 'M'}${point.x},${point.y}`;
  }).join(' ');
}

/** Curve width in the shared SVG viewBox. */
export const SLEEP_AXIS_WIDTH = 180;
/** A dragged end may never shorten the timer below one minute. */
export const MIN_SLEEP_SECONDS = 60;
export const MIN_SLEEP_MINUTES = 1;

/**
 * Drag handle to remaining seconds. `x` is the owner's axis coordinate
 * (0 = full length, 180 = no time left); the UI passes `180 - handleX`
 * so the right-end handle still reads left-to-right as "shorter".
 */
export function sleepSecondsFromHandle(x: number, totalSeconds: number): number {
  const distance = Number.isFinite(x) ? Math.max(0, Math.min(SLEEP_AXIS_WIDTH, x)) : 0;
  const base = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  return Math.max(MIN_SLEEP_SECONDS, Math.round((1 - distance / SLEEP_AXIS_WIDTH) * base));
}

/** Preview-mode counterpart: whole minutes, never below one. */
export function sleepMinutesFromHandle(x: number, totalMinutes: number): number {
  const distance = Number.isFinite(x) ? Math.max(0, Math.min(SLEEP_AXIS_WIDTH, x)) : 0;
  const base = Number.isFinite(totalMinutes) && totalMinutes > 0 ? totalMinutes : 0;
  return Math.max(MIN_SLEEP_MINUTES, Math.round((1 - distance / SLEEP_AXIS_WIDTH) * base));
}

/** Uses the existing countdown tick; no second clock or timer to drift. */
export function sleepProgress(totalMs: number, remainingSeconds: number): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0 || !Number.isFinite(remainingSeconds)) return 0;
  return Math.max(0, Math.min(1, (totalMs - remainingSeconds * 1000) / totalMs));
}
export function sleepStage(mode: SleepMode, progress: number): string {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (t >= 1) return '已结束';
  if (mode === 'off') return '保持音量';
  if (mode === 'late' && t < 2 / 3) return '保持音量';
  if (t >= 0.98) return '即将停止';
  if (mode === 'companion') return t < 0.25 ? '降至轻声' : '轻声尾段';
  if (t >= 0.8) return '轻声尾段';
  if (mode === 'gentle' && t < 0.15) return '缓慢起步';
  return mode === 'steady' ? '匀速渐弱' : '渐弱中';
}
