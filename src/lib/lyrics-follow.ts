/** 歌词面板「自动跟随」状态机（issue #27）。
 *
 *  规则（owner 2026-11-25 定）：
 *  - 手势进行中永不自动回中（即使手指短暂停住、或等过了空闲超时）；
 *  - 手动控制累计到 SUSTAINED_MS ⇒ 进入持久手动模式：松手、换行、空闲都不再自动跟随，
 *    只能由「回到当前」按钮 / 点行 / 重新打开面板显式恢复；
 *  - 短促手势不进入持久手动模式，但仍不被中途打断：松手后按原有 RESUME_MS 空闲超时恢复。
 *
 *  纯逻辑（时钟与定时器可注入），供组件与 scripts/test-lyrics-follow.mjs 共用。 */

/** 手动滚动停止后自动恢复跟随的等待（ms；owner 选定 3 秒） */
export const RESUME_MS = 3000;

/** 持续手动的判定阈值（ms）：沿用既有 RESUME_MS 的 3 秒值，不另立产品参数 */
export const SUSTAINED_MS = RESUME_MS;

export interface LyricsFollowSnapshot {
  /** 是否自动跟随当前行 */
  following: boolean;
  /** 是否处于持久手动模式（不因空闲而恢复） */
  persistent: boolean;
  /** 是否正在手势中（按下未松手） */
  gestureActive: boolean;
  /** 面板是否允许自动居中（following && !gestureActive）——组件的滚动门闩就用它 */
  autoCenter: boolean;
}

export interface LyricsFollowOptions {
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  resumeDelay?: number;
  sustainedDelay?: number;
  onChange?: (snapshot: LyricsFollowSnapshot) => void;
}

export interface LyricsFollow {
  readonly following: boolean;
  readonly persistent: boolean;
  readonly gestureActive: boolean;
  /** 允许自动居中（following 且不在手势中）；手势中恒为 false */
  readonly autoCenter: boolean;
  /** 手势开始（pointerdown / touchstart，可重复调用） */
  beginGesture(at?: number): void;
  /** 手势结束（pointerup / pointercancel / touchend，可重复调用） */
  endGesture(at?: number): void;
  /** 非手势型手动滚动（滚轮 / 滚动条拖动的离散事件） */
  noteManualScroll(at?: number): void;
  /** 显式恢复跟随：按钮、点行、开面板、切歌 */
  resume(): void;
  destroy(): void;
}

export function createLyricsFollow(opts: LyricsFollowOptions = {}): LyricsFollow {
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const cancel = opts.cancel ?? ((h) => clearTimeout(h));
  const resumeDelay = opts.resumeDelay ?? RESUME_MS;
  const sustainedDelay = opts.sustainedDelay ?? SUSTAINED_MS;

  let following = true;
  let persistent = false;
  let gestureActive = false;
  /** 本轮连续手动控制的起点；恢复跟随或重新开始一轮时清空 */
  let manualSince: number | null = null;
  let timer: number | null = null;

  function snapshot(): LyricsFollowSnapshot {
    return { following, persistent, gestureActive, autoCenter: following && !gestureActive };
  }

  function emit() {
    opts.onChange?.(snapshot());
  }

  function clearTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function enterManual(at: number) {
    if (manualSince === null) manualSince = at;
    if (following) following = false;
  }

  /** 达到持续阈值即锁定持久手动模式（幂等） */
  function markSustained(at: number): boolean {
    if (!persistent && manualSince !== null && at - manualSince >= sustainedDelay) {
      persistent = true;
      clearTimer();
    }
    return persistent;
  }

  /** 只在非手势、非持久状态下排一次空闲恢复 */
  function armResume() {
    clearTimer();
    if (persistent || gestureActive || following) return;
    timer = schedule(() => {
      timer = null;
      if (gestureActive || persistent) return;
      following = true;
      manualSince = null;
      emit();
    }, resumeDelay);
  }

  return {
    get following() {
      return following;
    },
    get persistent() {
      return persistent;
    },
    get gestureActive() {
      return gestureActive;
    },
    get autoCenter() {
      return following && !gestureActive;
    },

    beginGesture(at = now()) {
      if (gestureActive) {
        // pointerdown + touchstart 双发：手势起点不重置
        enterManual(at);
        emit();
        return;
      }
      gestureActive = true;
      clearTimer(); // 手势期间绝不自动恢复
      enterManual(at);
      emit();
    },

    endGesture(at = now()) {
      gestureActive = false;
      if (manualSince !== null && markSustained(at)) {
        emit();
        return;
      }
      armResume();
      emit();
    },

    noteManualScroll(at = now()) {
      if (gestureActive) {
        // 手势进行中的滚动事件属于同一轮手动控制：只累计，不排恢复
        enterManual(at);
        emit();
        return;
      }
      enterManual(at);
      if (markSustained(at)) {
        emit();
        return;
      }
      armResume();
      emit();
    },

    resume() {
      following = true;
      persistent = false;
      manualSince = null;
      clearTimer();
      emit();
    },

    destroy() {
      clearTimer();
    },
  };
}
