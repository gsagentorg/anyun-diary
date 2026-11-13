import type { Clip, Recording, Track } from './types';
import { audioUrl, buildRecTracks, dateCard } from './types';
import diaryData from '$lib/data.json';
import { trackKeyOf, pickShuffleIndex } from './playlist-core';
import { hasLyrics, lyricsFingerprint, lyricDisplayIndexAt, sameTimeGroupBounds } from './lyrics';
import { SleepAudio } from './sleep-audio';
import { isSleepMode, MIN_SLEEP_SECONDS, type SleepMode } from './sleep-curves';

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
  shuffleSkipSameTitle: boolean; // 随机抽歌时是否回避与已播曲目同名的歌（独立于上面的身份判定）
  shuffleRedo: number[]; // 随机模式「下一曲」回退栈：上一曲压入当前曲，下一曲优先弹回（先入后出）
  sessionRestored: boolean; // 本次加载是否从本地快照恢复了播放队列
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
  shuffleSkipSameTitle: true,
  shuffleRedo: [],
  sessionRestored: false,
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
  scheduleSessionSave();
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
    const rawSkip = window.localStorage.getItem(SKIP_SAME_KEY);
    if (rawSkip === '0' || rawSkip === 'false') player.shuffleSkipSameTitle = false;
    else if (rawSkip === '1' || rawSkip === 'true') player.shuffleSkipSameTitle = true;
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
  player.shuffleRedo = [];
  player.playedTitles = player.track ? [trackKey(player.track)] : [];
  scheduleSessionSave();
}

const SKIP_SAME_KEY = 'anyun-shuffle-skip-same';

/** 切换「随机避开同名」：写 state + localStorage；不影响「同名不同词算重复」的身份判定 */
export function setShuffleSkipSameTitle(v: boolean) {
  player.shuffleSkipSameTitle = v;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(SKIP_SAME_KEY, v ? '1' : '0');
    } catch {
      /* 忽略存储失败 */
    }
  }
  scheduleSessionSave();
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
  __anyunSessionInit?: boolean;
  __anyunSleepAudio?: SleepAudio;
  __anyunSyncSleep?: () => void;
};

function ensureAudio(): HTMLAudioElement {
  if (!gAudio.__anyunAudio) {
    const a = new Audio();
    a.preload = 'metadata';
    a.playbackRate = player.playbackRate; // 创建时即应用当前倍速
    // 一次性绑定：audio 的真实播放状态 → player.playing（M4 状态真实）
    a.addEventListener('play', () => {
      gAudio.__anyunSyncSleep?.();
      void gAudio.__anyunSleepAudio?.resume();
      if (a.paused) return;
      player.playing = true;
      setMediaPlaybackState('playing');
    });
    a.addEventListener('pause', () => {
      player.playing = false;
      setMediaPlaybackState('paused');
    });
    a.addEventListener('ended', () => {
      player.playing = false;
      setMediaPlaybackState('paused');
    });
    a.addEventListener('timeupdate', () => saveSessionProgress());
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
  // 声明为媒体播放会话：支持的平台据此改善锁屏控件与混音处理（不支持则忽略）
  try {
    const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (as) as.type = 'playback';
  } catch {
    /* 忽略 */
  }
  // 看门狗：每秒对账一次；回前台立刻对账（OS 抢占无法阻止，只保证状态诚实）
  setInterval(() => gAudio.__anyunFixFake?.(), 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      gAudio.__anyunFixFake?.();
      gAudio.__anyunSyncSleep?.();
      void gAudio.__anyunSleepAudio?.resume();
      // 回前台时刷新系统浮层状态，避免卡片停留在过期状态
      const a = gAudio.__anyunAudio;
      if (!player.track) setMediaPlaybackState('none');
      else setMediaPlaybackState(a && !a.paused ? 'playing' : 'paused');
    } else {
      writeSessionSnapshot(); // 切后台兜底保存
    }
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
  const a = getAudio(); // Resume a suspended gain graph within the track-selection gesture.
  a.src = audioUrl(t.clip.opus);
  a.load();
  a.play().catch(() => {});
  updateMediaSession(t);
  scheduleSessionSave();
}

/* ---------- Media Session：让系统媒体浮层（Windows/手机锁屏）显示歌名并可上/下一首 ---------- */

let mediaHandlersBound = false;

/** 系统媒体浮层的 metadata：有歌词时「歌名」处放当前歌词、「作者」处放歌名；无歌词保持原样 */
function buildMetadata(t: Track, lyricText: string | null): MediaMetadata {
  const md = Number.isFinite(t.rec.start) ? dateCard(t.rec.start).md : '';
  const name = t.clip.title || '（未识别）';
  // owner 2026-11-01：iOS 对每次元数据更新都会重取 artwork 造成封面闪烁 → 不再提供专辑图
  return new MediaMetadata({
    title: lyricText ?? name,
    artist: lyricText != null ? name : '安允日记',
    album: md ? `安允日记 · ${md}` : '安允日记',
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
    ms.setActionHandler('play', () => {
      getAudio()
        .play()
        .catch((e) => console.warn('[media] 系统播放按钮被浏览器拒绝：', e));
    });
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
  const idx = lyricDisplayIndexAt(t.clip.lyrics, pos, t.clip.offsetEnd - t.clip.offsetStart);
  // 同刻多行（含尾部超界折叠行）只推第一行（owner 2026-11-07：元数据无动画延迟概念）
  const group = sameTimeGroupBounds(t.clip.lyrics, idx, t.clip.offsetEnd - t.clip.offsetStart);
  const metaIdx = group ? group[0] : -1;
  if (metaIdx === mdLineIdx && mdClipFile === t.clip.opus) return;
  mdLineIdx = metaIdx;
  mdClipFile = t.clip.opus;
  navigator.mediaSession.metadata = buildMetadata(t, metaIdx < 0 ? null : t.clip.lyrics![metaIdx].text);
}

/** 同步系统浮层播放状态：不设的 UA 只能靠猜，iOS/macOS 锁屏控件可能因此卡在过期状态 */
export function setMediaPlaybackState(s: 'none' | 'paused' | 'playing') {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = s;
  } catch {
    /* 忽略 */
  }
}

/** 播放进度上报给系统浮层（timeupdate 里调用）；倍速跟实际值，防进度漂移 */
export function reportPlaybackState(duration: number, position: number) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: player.playbackRate > 0 ? player.playbackRate : 1,
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
  player.shuffleRedo = [];
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
    player.shuffleRedo = [];
    player.playedTitles = [trackKey(tracks[0])];
    playCurrent();
    return tracks.length;
  }
  player.playlist = [...player.playlist, ...tracks];
  scheduleSessionSave();
  return tracks.length;
}

/** 把一组曲目插到队列最前面并切到 list[i]（默认第一首）；既有队列整体后移保留，随机回退栈同步平移 */
export function prependAt(list: Track[], i = 0) {
  if (!list[i]) return;
  const n = list.length;
  player.history = player.history.map((h) => h + n);
  player.shuffleRedo = player.shuffleRedo.map((h) => h + n);
  const hadCur = player.pos >= 0;
  const curPos = player.pos;
  player.playlist = [...list, ...player.playlist];
  if (hadCur) {
    player.pos = curPos + n;
    recordVisit(); // 原当前曲以新下标入历史，上一曲可回
  }
  player.pos = i;
  playCurrent();
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
  player.shuffleRedo = player.shuffleRedo
    .map((h) => (h > index ? h - 1 : h))
    .filter((h) => h !== index);
  scheduleSessionSave();
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
  player.shuffleRedo = []; // 回退栈同理作废
  scheduleSessionSave();
}

/** 清空队列：移除除当前播放外的全部（无当前播放则全清） */
export function clearQueue() {
  const cur = player.pos >= 0 ? player.playlist[player.pos] : null;
  if (!cur) {
    player.playlist = [];
    player.pos = -1;
    player.shuffleRedo = [];
    scheduleSessionSave();
    return;
  }
  player.playlist = [cur];
  player.pos = 0;
  player.history = [];
  player.shuffleRedo = [];
  player.playedTitles = [trackKey(cur)];
  scheduleSessionSave();
}

/** 切换随机播放 */
export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  player.history = [];
  player.shuffleRedo = [];
  player.playedTitles = player.track ? [trackKey(player.track)] : [];
  scheduleSessionSave();
}

/** 把当前曲记入随机历史与已播（切走前调用） */
function recordVisit() {
  if (player.pos < 0) return;
  player.history.push(player.pos);
  const cur = player.playlist[player.pos];
  if (cur) {
    const k = trackKey(cur);
    if (!player.playedTitles.includes(k)) player.playedTitles.push(k);
  }
}

/** 在当前列表里随机挑一首：已播过的「曲目」不抽；开「随机避开同名」时同名已播歌一并回避；全播过则重置池 */
export function playRandom() {
  if (player.playlist.length === 0) return;
  const keys = player.playlist.map(trackKey);
  let avoid: Set<number> | undefined;
  if (player.shuffleSkipSameTitle) {
    const played = new Set(player.playedTitles);
    const avoidTitles = new Set(
      player.playlist.filter((_, i) => played.has(keys[i])).map((t) => t.clip.title),
    );
    avoid = new Set(
      player.playlist.map((_, i) => i).filter((i) => avoidTitles.has(player.playlist[i].clip.title)),
    );
    if (avoid.size === 0) avoid = undefined;
  }
  const pick = pickShuffleIndex(keys, player.playedTitles, player.pos, avoid);
  if (!pick) return;
  if (pick.reset) player.playedTitles = [];
  player.shuffleRedo = []; // 主动随机开新曲：旧的「下一曲回退栈」作废
  stepTo(pick.index);
}

/** 跳到列表内第 i 项（记录历史与已播曲目，供随机模式去重/回退） */
function stepTo(i: number) {
  if (i < 0 || i >= player.playlist.length || i === player.pos) return;
  recordVisit();
  player.shuffleRedo = []; // 手动定位 = 新方向，回退栈作废
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
  recordVisit();
  player.shuffleRedo = [];
  player.playlist = [...player.playlist.slice(0, at), track, ...player.playlist.slice(at)];
  player.pos = at;
  playCurrent();
}

/** 在当前播放列表中上/下一首；随机模式：上一曲压栈当前曲并弹历史，下一曲优先按栈弹回（先入后出），栈空才随机 */
export function step(delta: number) {
  if (player.shuffle) {
    if (delta > 0) {
      const nxt = player.shuffleRedo.pop();
      if (nxt != null && nxt >= 0 && nxt < player.playlist.length && nxt !== player.pos) {
        recordVisit(); // 跳回的曲也记历史：再按上一曲仍可返回
        player.pos = nxt;
        playCurrent();
        return;
      }
      playRandom();
    } else {
      if (player.pos >= 0) player.shuffleRedo.push(player.pos);
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

/* ---------- 会话快照：刷新后恢复队列/进度（保持暂停，绝不自动出声） ---------- */

const SESSION_KEY = 'anyun-session-v1';
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressSave = 0;

type SessionSnapshot = {
  v: 1;
  queue: string[]; // clip.file 有序列表（含重复项）
  cur: number; // 当前项下标（-1 = 无当前项）
  t: number; // 当前曲目进度（秒）
  shuffle: boolean;
  skipSame: boolean;
  dedup: boolean;
  rate: number;
};

function collectSnapshot(): SessionSnapshot | null {
  if (player.playlist.length === 0) return null;
  const a = gAudio.__anyunAudio;
  return {
    v: 1,
    queue: player.playlist.map((t) => t.clip.file),
    cur: player.pos,
    t: a && Number.isFinite(a.currentTime) ? a.currentTime : 0,
    shuffle: player.shuffle,
    skipSame: player.shuffleSkipSameTitle,
    dedup: player.dedupByName,
    rate: player.playbackRate,
  };
}

function writeSessionSnapshot() {
  if (typeof window === 'undefined') return;
  const snap = collectSnapshot();
  try {
    if (snap) window.localStorage.setItem(SESSION_KEY, JSON.stringify(snap));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 配额/隐私模式：静默 */
  }
}

/** 变更后去抖保存（队列/开关类变更调用） */
export function scheduleSessionSave() {
  if (typeof window === 'undefined') return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(writeSessionSnapshot, 300);
}

/** 进度节流保存：≥5s 一次；切后台/关页由监听兜底 */
export function saveSessionProgress() {
  const now = Date.now();
  if (now - lastProgressSave < 5000) return;
  lastProgressSave = now;
  writeSessionSnapshot();
}

/** 快照队列 → Track 列表：按 clip.file 反查，已删/改名的条目静默剔除 */
function snapshotRebuild(queue: string[]): Track[] {
  const recs = (diaryData as unknown as { recordings: Recording[] }).recordings;
  const byFile = new Map<string, Track>();
  for (const r of recs) {
    (r.clips ?? []).forEach((c, i) => {
      if (!byFile.has(c.file)) byFile.set(c.file, { clip: c, rec: r, index: i });
    });
  }
  const tracks: Track[] = [];
  for (const f of queue) {
    const t = byFile.get(f);
    if (t) tracks.push(t);
  }
  return tracks;
}

/** 测试专用：重置 initSession 的一次性守卫（生产代码勿调） */
export function __resetSessionGuardForTest() {
  gAudio.__anyunSessionInit = false;
}

/** 启动恢复：读快照 → 重建队列 → 预载当前曲到进度处（保持暂停）；仅浏览器调用一次 */
export function initSession() {
  if (typeof window === 'undefined' || gAudio.__anyunSessionInit) return;
  gAudio.__anyunSessionInit = true;

  let snap: SessionSnapshot | null = null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw) {
      const p = JSON.parse(raw) as SessionSnapshot;
      if (
        p &&
        p.v === 1 &&
        Array.isArray(p.queue) &&
        p.queue.every((x) => typeof x === 'string') &&
        typeof p.cur === 'number'
      ) {
        snap = p;
      }
    }
  } catch {
    snap = null; // 坏数据整条丢弃
  }

  if (snap) {
    const tracks = snapshotRebuild(snap.queue);
    if (tracks.length > 0) {
      const origFile =
        snap.cur >= 0 && snap.cur < snap.queue.length ? snap.queue[snap.cur] : null;
      const cur = origFile ? tracks.findIndex((t) => t.clip.file === origFile) : -1;
      player.playlist = tracks;
      player.pos = cur;
      player.shuffle = !!snap.shuffle;
      player.shuffleSkipSameTitle = snap.skipSame !== false;
      player.dedupByName = snap.dedup !== false;
      if (Number.isFinite(snap.rate) && snap.rate > 0) player.playbackRate = clampRate(snap.rate);
      player.sessionRestored = true;
      if (cur >= 0) {
        player.track = tracks[cur];
        const a = ensureAudio();
        a.src = audioUrl(tracks[cur].clip.opus);
        const t0 = Number.isFinite(snap.t) && snap.t > 0 ? snap.t : 0;
        const onMeta = () => {
          a.removeEventListener('loadedmetadata', onMeta);
          try {
            const d = Number.isFinite(a.duration) ? a.duration : 0;
            a.currentTime = d > 0 ? Math.min(t0, Math.max(0, d - 0.5)) : t0;
          } catch {
            /* 忽略 */
          }
          setMediaPlaybackState('paused');
        };
        a.addEventListener('loadedmetadata', onMeta);
        a.load();
        // 不调用 play()：刷新后保持暂停，等用户点播放
      }
      writeSessionSnapshot(); // 回写，清理已失效条目
    } else {
      try {
        window.localStorage.removeItem(SESSION_KEY);
      } catch {
        /* 忽略 */
      }
    }
  }

  // 关页兜底（pagehide 是移动端唯一可靠的卸载点；visibilitychange 在看门狗块里）
  window.addEventListener('pagehide', () => writeSessionSnapshot());
}

/** 停掉当前曲并清空当前项（不清队列）：URL 范围接管等场景用 */
export function stopCurrent() {
  const a = getAudio();
  a.pause();
  a.removeAttribute('src');
  a.load();
  player.track = null;
  player.pos = -1;
  player.loading = false;
  setMediaPlaybackState('none');
  scheduleSessionSave();
}

export function getAudio(): HTMLAudioElement {
  // UI/MediaSession callers reach this within a play gesture, before audio.play().
  void gAudio.__anyunSleepAudio?.resume();
  return ensureAudio();
}

/** 睡眠定时器：墙钟截止时间跨切歌/暂停不重置；只记忆预设，不恢复倒计时。 */
export const sleep = $state<{
  until: number | null;
  started: number | null;
  afterTrack: boolean;
  remaining: number;
  plannedSeconds: number; // 本次定时原始总时长：曲线手柄按它换算剩余比例
  fired: boolean;
  preset: SleepMode;
  mode: SleepMode; // 本次已启动的方式，和下一次选择分开
  notice: string | null;
}>({ until: null, started: null, afterTrack: false, remaining: 0, plannedSeconds: 0,
  fired: false, preset: 'gentle', mode: 'gentle', notice: null });

const SLEEP_PRESET_KEY = 'anyun-sleep-preset-v1';
export function initSleep() {
  if (typeof window === 'undefined') return;
  try {
    const value = window.localStorage.getItem(SLEEP_PRESET_KEY);
    if (isSleepMode(value)) sleep.preset = value;
  } catch { /* Storage is optional. */ }
}
export function setSleepPreset(mode: SleepMode) {
  if (!isSleepMode(mode)) return;
  sleep.preset = mode;
  try { window.localStorage.setItem(SLEEP_PRESET_KEY, mode); } catch { /* SSR/storage denied */ }
}
function sleepAudio() {
  return gAudio.__anyunSleepAudio ??= new SleepAudio(ensureAudio());
}

/** Public for deterministic clock tests and foreground recovery. */
export function syncSleep(now = Date.now(), reschedule = true) {
  if (sleep.until == null || sleep.started == null) return;
  sleep.remaining = Math.max(0, Math.ceil((sleep.until - now) / 1000));
  if (now >= sleep.until) { stopForSleep(); return; }
  if (sleep.mode !== 'off') {
    sleepAudio().tick(sleep.mode, (now - sleep.started) / (sleep.until - sleep.started));
    if (reschedule) sleepAudio().schedule(sleep.mode, sleep.started, sleep.until, now);
  }
}
gAudio.__anyunSyncSleep = () => syncSleep();

let sleepTimer: ReturnType<typeof setInterval> | null = null;
let sleepRun = 0;

function clearSleepTimer() {
  if (sleepTimer) {
    clearInterval(sleepTimer);
    sleepTimer = null;
  }
}

/** Click handler calls prepare before yielding, preserving the audio user gesture. */
export function startSleep(minutes: number | null, afterTrack = false) {
  if (!afterTrack && (minutes == null || !Number.isFinite(minutes) || minutes <= 0 || minutes > 600)) return;
  cancelSleep();
  sleep.fired = false;
  sleep.notice = null;
  if (afterTrack) {
    sleep.afterTrack = true;
    return;
  }
  sleep.mode = sleep.preset;
  sleep.started = Date.now();
  sleep.plannedSeconds = Math.ceil(minutes! * 60);
  sleep.until = sleep.started + sleep.plannedSeconds * 1000;
  sleep.remaining = sleep.plannedSeconds;
  const run = sleepRun;
  if (sleep.mode !== 'off') {
    sleep.notice = '正在启用渐弱音频引擎…';
    void sleepAudio().prepare().then((notice) => {
      if (sleepRun !== run || sleep.until == null) return;
      sleep.notice = notice;
      syncSleep();
    });
  }
  sleepTimer = setInterval(() => syncSleep(Date.now(), false), 100);
}

/**
 * 曲线手柄拖拽：只拉伸时间轴，保持 started / preset / mode 语义不变。
 * remainingSeconds 是「从现在起」的剩余秒数；重排 WebAudio 自动化并刷新 tick。
 */
export function adjustSleepEnd(remainingSeconds: number) {
  if (sleep.until == null || sleep.started == null) return;
  if (!Number.isFinite(remainingSeconds)) return;
  const seconds = Math.max(MIN_SLEEP_SECONDS, Math.round(remainingSeconds));
  const now = Date.now();
  sleep.fired = false;
  sleep.until = now + seconds * 1000;
  sleep.remaining = seconds;
  syncSleep(now, true);
}

/** 取消睡眠定时 */
export function cancelSleep() {
  ++sleepRun;
  clearSleepTimer();
  gAudio.__anyunSleepAudio?.restore();
  sleep.until = null;
  sleep.started = null;
  sleep.afterTrack = false;
  sleep.remaining = 0;
  sleep.plannedSeconds = 0;
  sleep.notice = null;
}

function stopForSleep() {
  ++sleepRun;
  const a = ensureAudio();
  a.pause(); // Pause BEFORE restoring gain, so expiry never emits a loud fragment.
  clearSleepTimer();
  gAudio.__anyunSleepAudio?.restore(true);
  sleep.until = null;
  sleep.started = null;
  sleep.afterTrack = false;
  sleep.remaining = 0;
  sleep.plannedSeconds = 0;
  sleep.fired = true;
  setMediaPlaybackState('paused');
}

if (import.meta.hot) import.meta.hot.dispose(() => cancelSleep());

/** 曲目自然结束时调用：睡眠定时（播完即停）优先于自动下一首 */
export function onTrackEnded() {
  if (sleep.until != null && Date.now() >= sleep.until) {
    stopForSleep();
    return;
  }
  if (sleep.afterTrack) {
    stopForSleep();
    return;
  }
  step(1);
}
