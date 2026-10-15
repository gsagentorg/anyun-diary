import type { Clip, Recording } from './types';
import { audioUrl } from './types';

/** 播放列表成员：切片 + 所属录像上下文 */
export interface Track {
  clip: Clip;
  rec: Recording;
  /** 与播放列表的关系：同一录像内的切片序号 */
  index: number;
}

/** 全局单例：当前播放项 + 加载态 + 当前播放列表 */
export const player = $state<{
  track: Track | null;
  loading: boolean;
  playlist: Track[];
  pos: number; // 当前播放项在 playlist 里的下标
}>({
  track: null,
  loading: false,
  playlist: [],
  pos: -1,
});

let audio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'metadata';
  }
  return audio;
}

/** 生成一个录像内的所有轨道（保持切片顺序） */
export function buildRecTracks(rec: Recording): Track[] {
  return (rec.clips ?? []).map((clip, index) => ({ clip, rec, index }));
}

function playCurrent() {
  const t = player.playlist[player.pos];
  if (!t) {
    player.track = null;
    return;
  }
  player.track = t;
  player.loading = true;
  const a = ensureAudio();
  a.src = audioUrl(t.clip.opus);
  a.load();
  a.play().catch(() => {});
}

/** 采纳一个播放列表并从第 i 项开始播放 */
export function adopt(list: Track[], i: number) {
  if (!list[i]) return;
  player.playlist = list;
  player.pos = i;
  playCurrent();
}

/** 播放某录像内的第 i 个切片：优先在当前列表里找，找不到则临时用「该录像」作为列表 */
export function playClip(rec: Recording, i: number) {
  const clip = rec.clips?.[i];
  if (!clip) return;
  const hit = player.playlist.findIndex((t) => t.rec.file === rec.file && t.clip.file === clip.file);
  if (hit >= 0) {
    player.pos = hit;
    playCurrent();
  } else {
    adopt(buildRecTracks(rec), i);
  }
}

/** 在当前播放列表中上/下一首 */
export function step(delta: number) {
  const pos = player.pos + delta;
  if (pos >= 0 && pos < player.playlist.length) {
    player.pos = pos;
    playCurrent();
  }
}

export function getAudio(): HTMLAudioElement {
  return ensureAudio();
}
