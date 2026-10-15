import type { Clip, Recording, Track } from './types';
import { audioUrl, buildRecTracks } from './types';

export type { Track };
export { buildRecTracks };

/** 全局单例：当前播放项 + 加载态 + 当前播放列表 */
export const player = $state<{
  track: Track | null;
  loading: boolean;
  playlist: Track[];
  pos: number; // 当前播放项在 playlist 里的下标
  shuffle: boolean; // 随机播放
  history: number[]; // 随机模式下已播过的下标（上一首用）
}>({
  track: null,
  loading: false,
  playlist: [],
  pos: -1,
  shuffle: false,
  history: [],
});

let audio: HTMLAudioElement | null = null;

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'metadata';
  }
  return audio;
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
  player.history = [];
  playCurrent();
}

/** 切换随机播放 */
export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  player.history = [];
}

/** 在当前列表里随机挑一首（尽量不重复已播）并播放 */
export function playRandom() {
  const n = player.playlist.length;
  if (n === 0) return;
  if (n === 1) {
    stepTo(0);
    return;
  }
  const recent = new Set([player.pos, ...player.history.slice(-Math.floor(n / 2))]);
  const pool = player.playlist.map((_, i) => i).filter((i) => !recent.has(i));
  const candidates = pool.length > 0 ? pool : player.playlist.map((_, i) => i).filter((i) => i !== player.pos);
  stepTo(candidates[Math.floor(Math.random() * candidates.length)]);
}

/** 跳到列表内第 i 项（记录历史，供随机模式返回上一首） */
function stepTo(i: number) {
  if (i < 0 || i >= player.playlist.length || i === player.pos) return;
  if (player.pos >= 0) player.history.push(player.pos);
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

/** 在当前播放列表中上/下一首（随机模式下走乱序） */
export function step(delta: number) {
  if (player.shuffle) {
    if (delta > 0) {
      playRandom();
    } else {
      const prev = player.history.pop();
      if (prev != null) {
        player.pos = prev;
        playCurrent();
      }
    }
    return;
  }
  const pos = player.pos + delta;
  if (pos >= 0 && pos < player.playlist.length) {
    player.pos = pos;
    playCurrent();
  }
}

export function getAudio(): HTMLAudioElement {
  return ensureAudio();
}

/** 睡眠定时器：定时停止 / 播完当前曲目停 */
export const sleep = $state<{
  until: number | null; // 到期时间戳（ms）
  afterTrack: boolean; // 播完当前曲目就停
  remaining: number; // 剩余秒
  fired: boolean; // 刚触发（供 UI 提示）
}>({ until: null, afterTrack: false, remaining: 0, fired: false });

let sleepTimer: ReturnType<typeof setInterval> | null = null;

function clearSleepTimer() {
  if (sleepTimer) {
    clearInterval(sleepTimer);
    sleepTimer = null;
  }
}

/** 启动睡眠定时：minutes 为分钟后停止；afterTrack=true 表示播完当前曲目即停 */
export function startSleep(minutes: number | null, afterTrack = false) {
  cancelSleep();
  sleep.fired = false;
  if (afterTrack) {
    sleep.afterTrack = true;
    return;
  }
  if (minutes == null || minutes <= 0) return;
  sleep.until = Date.now() + minutes * 60000;
  sleep.remaining = Math.round(minutes * 60);
  sleepTimer = setInterval(() => {
    if (sleep.until == null) return;
    const r = Math.max(0, Math.round((sleep.until - Date.now()) / 1000));
    sleep.remaining = r;
    if (r <= 0) stopForSleep();
  }, 1000);
}

/** 取消睡眠定时 */
export function cancelSleep() {
  clearSleepTimer();
  sleep.until = null;
  sleep.afterTrack = false;
  sleep.remaining = 0;
}

function stopForSleep() {
  const a = ensureAudio();
  a.pause();
  clearSleepTimer();
  sleep.until = null;
  sleep.afterTrack = false;
  sleep.remaining = 0;
  sleep.fired = true;
}

/** 曲目自然结束时调用：睡眠定时（播完即停）优先于自动下一首 */
export function onTrackEnded() {
  if (sleep.afterTrack) {
    stopForSleep();
    return;
  }
  step(1);
}
