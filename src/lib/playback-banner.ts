/**
 * 播放器错误横幅的纯状态机（issue #6）：横幅只描述「当前曲目 / 当前意图」的现行失败。
 *
 * 规则：
 *  - 失败事件带身份（queueEntryId / 原生 epoch）；身份与当前曲目不符 = 已切走的迟到事件，一律丢弃。
 *  - 用户显式暂停后不再有播放意图：暂停期间的后台重试失败既不出声也不复活横幅；
 *    显式暂停同时作废暂停前那条「播放失败」（那次尝试已被用户取消）。
 *  - 健康播放（playing）清掉任何过期横幅 —— 正在播就不可能存在现行失败。
 *  - 真正的现行失败保留，直到被解决（播放恢复 / 换曲）或被取代。
 *
 * 纯函数、无副作用，浏览器与原生壳共用，便于独立断言「横幅状态」与「播放意图」。
 */
export interface PlaybackBanner {
  /** 消息归属的曲目身份；'' = 尚无当前曲目 */
  identity: string;
  /** 可见的错误文案；'' = 无横幅 */
  message: string;
  /** 用户显式暂停中（没有播放意图） */
  paused: boolean;
  /** message 来自一次播放失败（相对队列校验之类的编辑提示） */
  failure: boolean;
}

export const NO_BANNER: PlaybackBanner = { identity: '', message: '', paused: false, failure: false };

/** 换曲：新曲目从干净横幅开始。 */
export function beginTrack(identity: string): PlaybackBanner {
  return { identity, message: '', paused: false, failure: false };
}

/** 用户点了播放：恢复意图；播放中不存在现行失败，旧横幅作废。 */
export function notePlay(state: PlaybackBanner, identity: string): PlaybackBanner {
  const base = state.identity === identity ? state : beginTrack(identity);
  if (!base.message && !base.failure && !base.paused) return base;
  return { identity: base.identity, message: '', paused: false, failure: false };
}

/** 用户显式暂停：本次播放尝试作废，暂停期间不得复活旧失败。 */
export function notePause(state: PlaybackBanner, identity: string): PlaybackBanner {
  return { identity, message: '', paused: true, failure: false };
}

/** 非播放类提示（如队列超预算）：与播放意图无关，但健康播放时同样会过期。 */
export function noteNotice(
  state: PlaybackBanner,
  identity: string,
  message: string,
): PlaybackBanner {
  const paused = state.identity === identity ? state.paused : false;
  return { identity, message, paused, failure: false };
}

/** 一次播放失败事件；只接受当前曲目、且当前确实有播放意图。 */
export function failPlayback(
  state: PlaybackBanner,
  identity: string,
  message: string,
): PlaybackBanner {
  if (!identity || state.identity !== identity) return state;
  if (state.paused) return state;
  if (state.message === message && state.failure) return state;
  return { ...state, message, failure: true };
}

/** 播放确实恢复（playing）：清掉过期横幅。 */
export function noteHealthy(state: PlaybackBanner, identity: string): PlaybackBanner {
  if (state.identity !== identity) return beginTrack(identity);
  if (!state.message) return state;
  return { ...state, message: '', failure: false };
}

/**
 * 原生壳回传的权威快照（含回前台 getState 的和解）。
 * 播放中 → 清横幅；停着且有 error → 仅在仍有播放意图时展示；
 * 显式暂停后原生侧的后台重试错误不属于当前意图，不得复活横幅。
 */
export function fromNative(
  state: PlaybackBanner,
  identity: string,
  native: { playing: boolean; error: string },
): PlaybackBanner {
  const base = state.identity === identity ? state : beginTrack(identity);
  if (native.playing) {
    if (!base.message && !base.failure && !base.paused) return base;
    return { identity: base.identity, message: '', paused: false, failure: false };
  }
  if (!native.error) {
    return base.message ? { ...base, message: '', failure: false } : base;
  }
  if (base.paused) return base;
  if (base.message === native.error && base.failure) return base;
  return { ...base, message: native.error, failure: true };
}
