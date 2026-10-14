import type { Clip, Recording } from './types';
import { audioUrl } from './types';

/** 当前播放的切片（含所属录像上下文，用于显示绝对时间） */
export interface Track {
  clip: Clip;
  rec: Recording;
  /** 与播放列表的关系：同一录像内的切片序号 */
  index: number;
}

/** 全局单例：当前播放项 + 加载态 */
export const player = $state<{ track: Track | null; loading: boolean }>({
  track: null,
  loading: false,
});

let audio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'metadata';
  }
  return audio;
}

/** 播放某录像内的第 i 个切片 */
export function playClip(rec: Recording, i: number) {
  const clips = rec.clips ?? [];
  if (!clips[i]) return;
  player.track = { clip: clips[i], rec, index: i };
  player.loading = true;
  const a = ensureAudio();
  a.src = audioUrl(clips[i].opus);
  a.load();
  a.play().catch(() => {});
}

/** 同一录像内上/下一首 */
export function step(delta: number) {
  const t = player.track;
  if (!t) return;
  const clips = t.rec.clips ?? [];
  const next = t.index + delta;
  if (next >= 0 && next < clips.length) playClip(t.rec, next);
}

export function getAudio(): HTMLAudioElement {
  return ensureAudio();
}
