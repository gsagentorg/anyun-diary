import type { Clip, Recording, Track } from './types';
import { audioUrl, buildRecTracks, dateCard } from './types';
import { trackKeyOf, pickShuffleIndex } from './playlist-core';
import { hasLyrics, lyricsFingerprint, lyricIndexAt } from './lyrics';

export type { Track };
export { buildRecTracks };

/** 全局单例：当前播放项 + 加载态 + 当前播放列表 */
export const player = $state<{
  track: Track | null;
  loading: boolean;
  playing: boolean; // 真实播放状态（由 audio 事件驱动 + 看门狗纠偏）
  playlist: Track[];
  pos: number; // 当前播放项在 playlist 里的下标
  shuffle: boolean; // 随机播放
  history: number[]; // 随机模式下已播过的下标（上一首用）
  playedTitles: string[]; // 已播曲目的「曲目标识」（同名歌曲视为同一首，随机不再抽）
  queueOpen: boolean; // 播放队列叠层开关
  playbackRate: number; // 播放倍速（clamp 到 [0.01, 8]）
  dedupByName: boolean; // 随机去重：同名不同词是否算重复（true=同名即同曲，不重抽）
  lyricsOpen: boolean; // 歌词面板开关
}>({
  track: null,
  loading: false,
  playing: false,
  playlist: [],
  pos: -1,
  shuffle: false,
  history: [],
  playedTitles: [],
  queueOpen: false,
  playbackRate: 1,
  dedupByName: true,
  lyricsOpen: false,
});

const RATE_KEY = 'anyun-rate';
const RATE_MIN = 0.01;
const RATE_MAX = 8;

function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, r));
}

/** 设置播放倍速：clamp 到 [0.01, 8]，写 state + localStorage('anyun-rate') */
export function setRate(r: number) {
  const v = clampRate(r);
  player.playbackRate = v;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(RATE_KEY, String(v));
    } catch {
      /* 忽略存储失败 */
    }
  }
}

/** 从 localStorage 恢复倍速（非法值回退 1）；仅浏览器环境调用 */
export function initRate() {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(RATE_KEY);
    if (raw != null) player.playbackRate = clampRate(Number(raw));
  } catch {
    /* 忽略读取失败 */
  }
}

const DEDUP_KEY = 'anyun-dedup';

/** 从 localStorage 恢复「同名不同词算重复」开关（缺省/非法值一律 true）；仅浏览器环境调用 */
export function initDedup() {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(DEDUP_KEY);
    if (raw === '0' || raw === 'false') player.dedupByName = false;
    else if (raw === '1' || raw === 'true') player.dedupByName = true;
  } catch {
    /* 忽略读取失败 */
  }
}

/** 切换「同名不同词算重复」：写 state + localStorage('anyun-dedup')；键基变了 → 清随机历史 */
export function setDedupByName(v: boolean) {
  player.dedupByName = v;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(DEDUP_KEY, v ? '1' : '0');
    } catch {
      /* 忽略存储失败 */
    }
  }
  player.history = [];
  player.playedTitles = player.track ? [trackKey(player.track)] : [];
}

/** 曲目标识：同名歌曲（含不同场次）视为同一首；无标题的用切片文件名兜底 */
function trackKey(t: Track): string {
  if (player.dedupByName) return trackKeyOf(t.clip);
  return hasLyrics(t.clip) ? `L:${t.clip.title}#${lyricsFingerprint(t.clip)}` : trackKeyOf(t.clip);
}

/** 音频单例挂 globalThis：HMR 重载本模块也不会产生第二实例（防叠播） */
const gAudio = globalThis as typeof globalThis & {
  __anyunAudio?: HTMLAudioElement;
  /** 看门狗去重 + 指向最新模块的纠偏函数（HMR 后仍纠正当前 state） */
  __anyunFixFake?: () => void;
  __anyunWatchdog?: boolean;
};

function ensureAudio(): HTMLAudioElement {
  if (!gAudio.__anyunAudio) {
    const a = new Audio();
    a.preload = 'metadata';
    a.playbackRate = player.playbackRate; // 创建时即应用当前倍速
    // 一次性绑定：audio 的真实播放状态 → player.playing（M4 状态真实）
    a.addEventListener('play', () => (player.playing = true));
    a.addEventListener('pause', () => (player.playing = false));
    a.addEventListener('ended', () => (player.playing = false));
    gAudio.__anyunAudio = a;
  }
  return gAudio.__anyunAudio;
}

/** 假播放纠偏：状态说在播、音频却 paused（移动端切后台被系统抢占/被其它媒体打断）→ 立即改回未播放 */
function fixFakePlaying() {
  const a = gAudio.__anyunAudio;
  if (!a || !player.track || !player.playing) return;
  if (a.paused) player.playing = false;
}
gAudio.__anyunFixFake = fixFakePlaying;

if (typeof window !== 'undefined' && !gAudio.__anyunWatchdog) {
  gAudio.__anyunWatchdog = true;
  // 看门狗：每秒对账一次；回前台立刻对账（OS 抢占无法阻止，只保证状态诚实）
  setInterval(() => gAudio.__anyunFixFake?.(), 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') gAudio.__anyunFixFake?.();
  });
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
  updateMediaSession(t);
}

/* ---------- Media Session：让系统媒体浮层（Windows/手机锁屏）显示歌名并可上/下一首 ---------- */

let mediaHandlersBound = false;

/** 系统媒体浮层的 metadata：有歌词时「歌名」处放当前歌词、「作者」处放歌名；无歌词保持原样 */
function buildMetadata(t: Track, lyricText: string | null): MediaMetadata {
  const md = Number.isFinite(t.rec.start) ? dateCard(t.rec.start).md : '';
  const name = t.clip.title || '（未识别）';
  return new MediaMetadata({
    title: lyricText ?? name,
    artist: lyricText != null ? name : '安允日记',
    album: md ? `安允日记 · ${md}` : '安允日记',
    artwork: [{ src: '/brand/cover.jpg', sizes: 'any', type: 'image/jpeg' }],
  });
}

// 歌词 → 系统浮层的去重缓存：同一曲目同一行不重复构造 MediaMetadata
let mdLineIdx = -1;
let mdClipFile = '';

function updateMediaSession(t: Track) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  mdLineIdx = -1;
  mdClipFile = '';
  ms.metadata = buildMetadata(t, null);
  if (!mediaHandlersBound) {
    mediaHandlersBound = true;
    ms.setActionHandler('play', () => getAudio().play().catch(() => {}));
    ms.setActionHandler('pause', () => getAudio().pause());
    ms.setActionHandler('previoustrack', () => step(-1));
    ms.setActionHandler('nexttrack', () => step(1));
    ms.setActionHandler('seekbackward', (d) => {
      const a = getAudio();
      a.currentTime = Math.max(0, a.currentTime - (d?.seekOffset ?? 10));
    });
    ms.setActionHandler('seekforward', (d) => {
      const a = getAudio();
      a.currentTime = Math.min(a.duration || 0, a.currentTime + (d?.seekOffset ?? 10));
    });
  }
}

/** 播放进度变化时把当前歌词行同步到系统媒体浮层（仅在有歌词的曲目上生效） */
export function syncLyricMetadata(t: Track | null, pos: number) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!t || !hasLyrics(t.clip) || !Number.isFinite(pos)) return;
  const idx = lyricIndexAt(t.clip.lyrics, pos);
  if (idx === mdLineIdx && mdClipFile === t.clip.opus) return;
  mdLineIdx = idx;
  mdClipFile = t.clip.opus;
  navigator.mediaSession.metadata = buildMetadata(t, idx < 0 ? null : t.clip.lyrics![idx].text);
}

/** 播放进度上报给系统浮层（timeupdate 里调用） */
export function reportPlaybackState(duration: number, position: number) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: 1,
    });
  } catch {
    /* 浏览器拒绝非法值时忽略 */
  }
}

/** 采纳一个播放列表并从第 i 项开始播放 */
export function adopt(list: Track[], i: number) {
  if (!list[i]) return;
  player.playlist = list;
  player.pos = i;
  player.history = [];
  player.playedTitles = [trackKey(list[i])];
  playCurrent();
}

/** 按时间生成结果的插入语义：空闲（无当前曲）或空队列 → 整队替换并从首项播放；正在播 → append 队尾不动当前。返回插入数 */
export function insertRange(tracks: Track[]): number {
  if (tracks.length === 0) return 0;
  if (player.playlist.length === 0 || !player.track) {
    player.playlist = tracks;
    player.pos = 0;
    player.history = [];
    player.playedTitles = [trackKey(tracks[0])];
    playCurrent();
    return tracks.length;
  }
  player.playlist = [...player.playlist, ...tracks];
  return tracks.length;
}

/** 定位播放队列中第 i 项（记录历史与已播曲目，供随机模式去重/回退） */
export function playAt(i: number) {
  stepTo(i);
}

/** 移除队列中指定行：移除项在当前项之前 pos--；等于当前项则顺延播放下一首/停止 */
export function removeAt(index: number) {
  if (index < 0 || index >= player.playlist.length) return;
  player.playlist = player.playlist.filter((_, i) => i !== index);
  player.history = player.history.map((h) => (h > index ? h - 1 : h)).filter((h) => h !== index);
  if (index < player.pos) {
    player.pos -= 1;
  } else if (index === player.pos) {
    if (player.pos >= player.playlist.length) {
      player.pos = -1;
      player.track = null;
      getAudio().pause();
    } else {
      playCurrent();
    }
  }
}

/** 手动调序：把队列中 from 项移动到 to 位置；越界或相同位置直接返回 */
export function moveTrack(from: number, to: number) {
  const n = player.playlist.length;
  if (from < 0 || to < 0 || from >= n || to >= n || from === to) return;
  const removed = player.playlist.splice(from, 1)[0];
  player.playlist.splice(to, 0, removed);
  if (from === player.pos) {
    player.pos = to;
  } else if (from < player.pos && to >= player.pos) {
    player.pos -= 1;
  } else if (from > player.pos && to <= player.pos) {
    player.pos += 1;
  }
  player.history = []; // 历史存的是下标，重排后已失效；清空避免随机回退错乱
}

/** 清空队列：移除除当前播放外的全部（无当前播放则全清） */
export function clearQueue() {
  const cur = player.pos >= 0 ? player.playlist[player.pos] : null;
  if (!cur) {
    player.playlist = [];
    player.pos = -1;
    return;
  }
  player.playlist = [cur];
  player.pos = 0;
  player.history = [];
  player.playedTitles = [trackKey(cur)];
}

/** 切换随机播放 */
export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  player.history = [];
  player.playedTitles = player.track ? [trackKey(player.track)] : [];
}

/** 在当前列表里随机挑一首：已播过的「曲目」（含同名歌曲）优先不抽；全播过则重置池 */
export function playRandom() {
  if (player.playlist.length === 0) return;
  const keys = player.playlist.map(trackKey);
  const pick = pickShuffleIndex(keys, player.playedTitles, player.pos);
  if (!pick) return;
  if (pick.reset) player.playedTitles = [];
  stepTo(pick.index);
}

/** 跳到列表内第 i 项（记录历史与已播曲目，供随机模式去重/回退） */
function stepTo(i: number) {
  if (i < 0 || i >= player.playlist.length || i === player.pos) return;
  if (player.pos >= 0) {
    player.history.push(player.pos);
    const cur = player.playlist[player.pos];
    if (cur) {
      const k = trackKey(cur);
      if (!player.playedTitles.includes(k)) player.playedTitles.push(k);
    }
  }
  player.pos = i;
  playCurrent();
}

/** 播放某录像内的第 i 个切片：已在当前列表（按 clip.file）则定位播放；否则构造曲目插入当前播放位置之后并播放，绝不整体替换列表 */
export function playClip(rec: Recording, i: number) {
  const clip = rec.clips?.[i];
  if (!clip) return;
  const hit = player.playlist.findIndex((t) => t.clip.file === clip.file);
  if (hit >= 0) {
    player.pos = hit;
    playCurrent();
    return;
  }
  const track = buildRecTracks(rec)[i];
  if (!track) return;
  const at = player.pos < 0 ? 0 : player.pos + 1;
  if (player.pos >= 0) {
    player.history.push(player.pos);
    const cur = player.playlist[player.pos];
    if (cur) {
      const k = trackKey(cur);
      if (!player.playedTitles.includes(k)) player.playedTitles.push(k);
    }
  }
  player.playlist = [...player.playlist.slice(0, at), track, ...player.playlist.slice(at)];
  player.pos = at;
  playCurrent();
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
