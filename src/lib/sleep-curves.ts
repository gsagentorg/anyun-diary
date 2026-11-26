/** Relative gain, not system volume. Curves are defined in dB for predictable fading. */
export const SLEEP_CUSTOM_VERSION = 1;
export interface SleepCustomParameters { holdPercent: number; endDb: number; exponent: number; tailPercent: number; }
export const DEFAULT_SLEEP_CUSTOM: Readonly<SleepCustomParameters> = Object.freeze({ holdPercent: 30, endDb: -24, exponent: 2, tailPercent: 10 });
export const SLEEP_CUSTOM_FIELDS = [
  { key: 'holdPercent', label: '保持原音量（%）', min: 0, max: 90, step: 1 },
  { key: 'endDb', label: '渐弱终点（dB）', min: -60, max: 0, step: 1 },
  { key: 'exponent', label: '下降指数', min: 0.25, max: 4, step: 0.05 },
  { key: 'tailPercent', label: '归零尾段（%）', min: 0, max: 30, step: 1 },
] as const;
/** Strict, atomic validation: corrupt/unknown payloads never partially change a plan. */
export function validateSleepCustom(value: unknown): SleepCustomParameters | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const { key, min, max } of SLEEP_CUSTOM_FIELDS) {
    const n = record[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return null;
  }
  return Object.fromEntries(SLEEP_CUSTOM_FIELDS.map(({ key }) => [key, record[key]])) as unknown as SleepCustomParameters;
}
export function sleepCustomSnapshot(value: unknown): SleepCustomParameters {
  return validateSleepCustom(value) ?? { ...DEFAULT_SLEEP_CUSTOM };
}
export function parseSleepCustom(raw: string | null): SleepCustomParameters {
  try {
    const data = JSON.parse(raw ?? 'null');
    return data?.version === SLEEP_CUSTOM_VERSION ? sleepCustomSnapshot(data.parameters) : { ...DEFAULT_SLEEP_CUSTOM };
  } catch { return { ...DEFAULT_SLEEP_CUSTOM }; }
}
/** Reserve at least half the post-hold interval for dB descent. A requested tail
 * overlapping hold is shortened, not shifted into hold: h=.9, tail=.3 => tail=.05. */
export function sleepCustomWindow(value: unknown) {
  const parameters = sleepCustomSnapshot(value);
  const hold = parameters.holdPercent / 100;
  const tail = Math.min(parameters.tailPercent / 100, (1 - hold) / 2);
  return { parameters, hold, tail, fade: 1 - hold - tail };
}
export const SLEEP_MODES = [
  { id: 'gentle', label: '柔和渐隐', description: '轻轻起步，中段变轻，最后柔和收尾。' },
  { id: 'steady', label: '匀速渐隐', description: '全程按相同分贝速度，稳定地变轻。' },
  { id: 'companion', label: '轻声陪伴', description: '前段降到轻声，留下较长的微弱尾声。' },
  { id: 'late', label: '先听后睡', description: '前 2/3 时间正常听，最后 1/3 柔和渐隐。' },
  { id: 'cliff', label: '长听快断', description: '开始几乎不降，随后逐渐加速下降，最后从仍能听清的音量直接切断。' },
  { id: 'hold', label: '平稳后切', description: '绝大部分时间保持原音量，末端小幅下降后干脆切断。' },
  { id: 'stair', label: '阶梯渐弱', description: '分四级稳定下降，每级都保持可听清的音量，最后切断。' },
  { id: 'custom', label: '自定义参数', description: '保持、分贝终点、下降指数和归零尾段均可调整。' },
  { id: 'off', label: '到时停止（不渐弱）', description: '保持原音量，到时间直接暂停。' },
] as const;
export type SleepMode = (typeof SLEEP_MODES)[number]['id'];
export function isSleepMode(value: unknown): value is SleepMode {
  return SLEEP_MODES.some((mode) => mode.id === value);
}
const smooth = (x: number) => x * x * (3 - 2 * x);
/** Modes that end on a hard cut: they hold a still-audible level, then jump to silence.
 * Rationale: a barely-audible tail is more tiring than a clean stop, so these skip the
 * -60 dB whisper and the final 2% taper used by the gradual modes. */
const CUT_MODES: ReadonlySet<SleepMode> = new Set(['cliff', 'hold', 'stair']);
/** Four stable steps (0, -6, -12, -18 dB); each step holds, then crossfades in 10% of its slot. */
function stairDepth(t: number): number {
  const levels = [0, 0.1, 0.2, 0.3];
  const index = Math.min(3, Math.floor(t / 0.25));
  const local = (t - index * 0.25) / 0.25;
  const from = levels[index];
  const to = levels[Math.min(3, index + 1)];
  return from + (to - from) * smooth(Math.max(0, Math.min(1, (local - 0.9) / 0.1)));
}
export function sleepGain(mode: SleepMode, progress: number, custom?: SleepCustomParameters): number {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (mode === 'off') return 1;
  if (t >= 1) return 0;
  if (mode === 'custom') {
    const { parameters, hold, tail, fade } = sleepCustomWindow(custom);
    const u = Math.max(0, Math.min(1, (t - hold) / fade));
    const gain = Math.pow(10, parameters.endDb * Math.pow(u, parameters.exponent) / 20);
    return gain * (tail > 0 && t > 1 - tail ? 1 - smooth((t - (1 - tail)) / tail) : 1);
  }
  let depth: number;
  if (mode === 'steady') depth = t;
  else if (mode === 'companion') {
    // Reach -18 dB at 25%, then spend the rest of the time fading the quiet tail.
    depth = t < 0.25 ? 0.3 * smooth(t / 0.25) : 0.3 + 0.7 * smooth((t - 0.25) / 0.75);
  } else if (mode === 'late') depth = smooth(Math.max(0, (t - 2 / 3) * 3));
  // Slow start, accelerating descent: ~-1.8 dB at the midpoint, -14.4 dB right before the cut.
  else if (mode === 'cliff') depth = 0.24 * t * t * t;
  // Hold the original level for 82% of the window, then settle to -12 dB and cut.
  else if (mode === 'hold') depth = t < 0.82 ? 0 : 0.2 * smooth(Math.min(1, (t - 0.82) / 0.15));
  else if (mode === 'stair') depth = stairDepth(t);
  else depth = smooth(t);
  const gain = Math.pow(10, (-60 * depth) / 20);
  // Cut modes jump from their last audible level straight to zero at the deadline.
  if (CUT_MODES.has(mode)) return gain;
  // The last 2% closes the -60 dB tail to true zero, not an abrupt tiny step.
  return gain * (t > 0.98 ? 1 - smooth((t - 0.98) / 0.02) : 1);
}
/** Shared coordinates keep the moving marker exactly on the plotted dB curve. */
export function sleepCurvePoint(mode: SleepMode, progress: number, custom?: SleepCustomParameters) {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  const gain = sleepGain(mode, t, custom);
  const height = gain <= 0 ? 0 : Math.max(0, 1 + 20 * Math.log10(gain) / 60);
  return { x: 180 * t, y: Number((38 - 34 * height).toFixed(2)) };
}
export function sleepCurvePath(mode: SleepMode, custom?: SleepCustomParameters): string {
  return Array.from({ length: 61 }, (_, i) => {
    const point = sleepCurvePoint(mode, i / 60, custom);
    return `${i ? 'L' : 'M'}${point.x},${point.y}`;
  }).join(' ');
}

/** Curve plot width in the shared 188-wide viewBox. */
export const SLEEP_CURVE_WIDTH = 180;
/** Curve width in the shared SVG viewBox (legacy alias used by the handle helpers). */
export const SLEEP_AXIS_WIDTH = SLEEP_CURVE_WIDTH;
/**
 * Half-width of the drag track in viewBox units. The whole vertical line is the hit area
 * (≈44 px tall × ≈26 px wide in viewBox units; ≈42 px wide on a phone), because a
 * dot-sized target is unreliable on iOS.
 */
export const SLEEP_TRACK_HALF_WIDTH = 13;
/** Minimum remaining time so a drag near the right edge cannot stop playback instantly.
 * Literal rather than `MIN_SLEEP_SECONDS` to keep module-init order independent. */
export const SLEEP_MIN_REMAINING_SECONDS = 60;

/** Clamp a point on the curve axis to the plotted range. */
export function clampCurveX(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(SLEEP_CURVE_WIDTH, x)) : 0;
}
/** Curve x coordinate to fade progress (0 = start, 1 = deadline). */
export function sleepSeekProgress(x: number): number {
  return clampCurveX(x) / SLEEP_CURVE_WIDTH;
}
/** Hit test for the drag track: the full vertical line, not just the marker dot. */
export function sleepTrackHit(pointerX: number, handleX: number, halfWidth = SLEEP_TRACK_HALF_WIDTH): boolean {
  if (!Number.isFinite(pointerX) || !Number.isFinite(handleX)) return false;
  const half = Number.isFinite(halfWidth) && halfWidth > 0 ? halfWidth : SLEEP_TRACK_HALF_WIDTH;
  return Math.abs(pointerX - handleX) <= half;
}
/**
 * Jitter dead zone for an active drag, in progress units (2 of 180 viewBox units ≈ 3 px on a
 * phone). A resting finger still reports sub-pixel pointer moves; without the dead zone the
 * handle and the derived countdown wobble between neighbouring values as the finger is held.
 * Deliberate slow drags move far beyond it.
 */
export const SLEEP_DRAG_DEAD_ZONE = 0.01;
/** Progress a drag may reach without dropping below the minimum remaining time. */
export function sleepSeekLimit(plannedSeconds: number): number {
  if (!Number.isFinite(plannedSeconds) || plannedSeconds <= 0) return 0;
  return Math.max(0, 1 - Math.min(plannedSeconds, SLEEP_MIN_REMAINING_SECONDS) / plannedSeconds);
}
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
export function sleepStage(mode: SleepMode, progress: number, custom?: SleepCustomParameters): string {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (t >= 1) return '已结束';
  if (mode === 'off') return '保持音量';
  if (mode === 'custom') {
    const { hold, tail } = sleepCustomWindow(custom);
    return t < hold ? '保持音量' : tail > 0 && t >= 1 - tail ? '归零尾段' : tail === 0 && t >= 0.96 ? '即将切断' : '自定义渐弱';
  }
  if (mode === 'late' && t < 2 / 3) return '保持音量';
  // Cut modes announce the jump instead of the whisper tail.
  if (mode === 'cliff') return t >= 0.94 ? '即将切断' : t < 0.55 ? '缓慢下降' : '加速下降';
  if (mode === 'hold') return t < 0.82 ? '保持音量' : t >= 0.96 ? '即将切断' : '末段轻降';
  if (mode === 'stair') return t >= 0.96 ? '即将切断' : '阶梯渐弱';
  if (t >= 0.98) return '即将停止';
  if (mode === 'companion') return t < 0.25 ? '降至轻声' : '轻声尾段';
  if (t >= 0.8) return '轻声尾段';
  if (mode === 'gentle' && t < 0.15) return '缓慢起步';
  return mode === 'steady' ? '匀速渐弱' : '渐弱中';
}
