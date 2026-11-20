/**
 * 播放模式：单一三态循环（随机 → 单曲循环 → 顺序）。
 * 纯函数模块，供播放器内核、UI 与测试共用。
 */
export type PlayMode = 'random' | 'repeat-one' | 'sequential';

export const PLAY_MODES: readonly { id: PlayMode; label: string; hint: string }[] = [
  { id: 'random', label: '随机播放', hint: '打乱队列，已播曲目在抽干前不重复' },
  { id: 'repeat-one', label: '单曲循环', hint: '当前曲结束后从头再播' },
  { id: 'sequential', label: '顺序播放', hint: '按队列顺序播放，到末尾停止' },
];

export function isPlayMode(value: unknown): value is PlayMode {
  return value === 'random' || value === 'repeat-one' || value === 'sequential';
}

/** 循环切换顺序：随机 → 单曲循环 → 顺序 → 随机 */
export function nextPlayMode(mode: PlayMode): PlayMode {
  if (mode === 'random') return 'repeat-one';
  if (mode === 'repeat-one') return 'sequential';
  return 'random';
}

export function playModeLabel(mode: PlayMode): string {
  return PLAY_MODES.find((m) => m.id === mode)?.label ?? '顺序播放';
}