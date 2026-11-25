// 歌词面板「自动跟随」状态机测试（issue #27）：
// 手势中永不回中；持续手动 ⇒ 持久手动（空闲不恢复）；短手势不被中途打断；显式恢复可用。
// 纯逻辑 + 假时钟/假定时器，不依赖浏览器与真实音频。
import {
  createLyricsFollow,
  RESUME_MS,
  SUSTAINED_MS,
} from '../src/lib/lyrics-follow.ts';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name);
  }
};

/** 假时钟 + 假定时器：advance() 按到期顺序逐个触发回调 */
function harness(overrides = {}) {
  const state = { t: 0, timers: new Map(), nextId: 1 };
  const schedule = (cb, ms) => {
    const id = state.nextId++;
    state.timers.set(id, { cb, at: state.t + ms });
    return id;
  };
  const cancel = (id) => state.timers.delete(id);
  const changes = [];
  const follow = createLyricsFollow({
    now: () => state.t,
    schedule,
    cancel,
    onChange: (s) => changes.push({ ...s, at: state.t }),
    ...overrides,
  });
  const advance = (ms) => {
    const end = state.t + ms;
    for (;;) {
      let due = null;
      for (const [id, v] of state.timers) {
        if (v.at <= end && (!due || v.at < due[1].at)) due = [id, v];
      }
      if (!due) break;
      state.timers.delete(due[0]);
      state.t = due[1].at;
      due[1].cb();
    }
    state.t = end;
  };
  return { state, follow, advance, changes, pending: () => state.timers.size };
}

// —— 常量：阈值沿用既有的 3 秒空闲恢复值，不另立产品参数 ——
ok(RESUME_MS === 3000, 'RESUME_MS keeps owner-selected 3s');
ok(SUSTAINED_MS === RESUME_MS, 'sustained threshold reuses the idle-resume constant');

// —— 初始 ——
{
  const h = harness();
  ok(h.follow.following === true, 'starts following');
  ok(h.follow.persistent === false, 'starts non-persistent');
  ok(h.follow.gestureActive === false, 'starts outside gesture');
  ok(h.follow.autoCenter === true, 'starts allowing auto-center');
}

// —— 按下即停跟随（不等手势结束、不等空闲超时）——
{
  const h = harness();
  h.follow.beginGesture();
  ok(h.follow.following === false, 'gesture start stops following immediately');
  ok(h.follow.gestureActive === true, 'gesture active');
  h.advance(RESUME_MS * 2);
  ok(h.follow.following === false, 'no auto-resume while finger stays down');
  ok(h.pending() === 0, 'no resume timer armed during gesture');
}

// —— autoCenter 门闩：组件滚动用的就是这个字段 ——
// 「手势跨歌词变化 + 定时器到期」= 时间前进、行变化，autoCenter 必须一直 false。
{
  const h = harness();
  h.follow.beginGesture();
  ok(h.follow.autoCenter === false, 'auto-center blocked as soon as the gesture starts');
  h.advance(600); // 行变化：状态机无事件，门闩不得自己翻回
  ok(h.follow.autoCenter === false, 'auto-center stays blocked across lyric changes');
  h.advance(RESUME_MS); // 定时器到期
  ok(h.follow.autoCenter === false, 'auto-center stays blocked past the idle timeout');
  h.advance(4000);
  ok(h.follow.autoCenter === false, 'auto-center stays blocked on a long hold');
  h.follow.endGesture();
  ok(h.follow.autoCenter === false, 'auto-center still blocked after a sustained release');
  h.follow.resume();
  ok(h.follow.autoCenter === true, 'explicit resume re-enables auto-center');
}

// —— 手指短暂停住（无事件）后继续拖：仍不回中，且达阈值后持久 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(800); // 拖动
  h.advance(2500); // 手指停住、无任何事件（已越过 3s 空闲）
  ok(h.follow.following === false, 'brief pause without release does not resume');
  // 「歌词行变化」在状态机层面不产生事件，跟随必须仍是关的
  h.advance(1200); // 累计 4.5s > 阈值
  h.follow.endGesture();
  ok(h.follow.persistent === true, 'sustained hold (with pause) enters persistent mode');
  ok(h.follow.following === false, 'persistent mode keeps following off after release');
  h.advance(RESUME_MS * 10);
  ok(h.follow.following === false, 'persistent mode does not expire on idle');
  ok(h.follow.persistent === true, 'persistent flag survives idle');
}

// —— 手势中跨过阈值、松手之前也绝不回中（含定时器到期）——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(RESUME_MS + 1);
  ok(h.follow.following === false, 'threshold crossing mid-gesture does not resume');
  h.follow.endGesture();
  ok(h.follow.persistent === true, 'crossing threshold mid-gesture makes it persistent');
}

// —— 短促手势：不进入持久模式，但中途不被打断；松手后按既有空闲超时恢复 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(500);
  ok(h.follow.following === false, 'brief gesture turns following off');
  h.follow.endGesture();
  ok(h.follow.persistent === false, 'brief gesture does not enter persistent mode');
  h.advance(RESUME_MS - 1);
  ok(h.follow.following === false, 'brief gesture keeps manual view during idle window');
  ok(h.follow.autoCenter === false, 'brief gesture blocks auto-center during idle window');
  h.advance(1);
  ok(h.follow.following === true, 'brief gesture resumes following after idle delay');
  ok(h.follow.persistent === false, 'resume clears persistent flag');
  ok(h.follow.autoCenter === true, 'brief gesture re-enables auto-center after idle delay');
}

// —— 短手势后立刻再交互：仍按同一轮累计，越阈值才持久 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(1000);
  h.follow.endGesture();
  h.advance(500);
  h.follow.beginGesture(); // 重新按下时仍在空闲窗口内
  h.advance(1600); // 自首次按下累计 3100ms
  h.follow.endGesture();
  ok(h.follow.persistent === true, 'continuous manual control accumulates across gestures');
}

// —— 指针事件双发（pointerdown + touchstart）不重置起点 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(2000);
  h.follow.beginGesture(); // 第二个事件
  h.advance(1100); // 自首次 3100ms
  h.follow.endGesture();
  ok(h.follow.persistent === true, 'duplicate gesture-start does not reset the clock');
}

// —— 滚轮/滚动条：离散手动滚动，低于阈值空闲恢复，高于阈值持久 ——
{
  const h = harness();
  h.follow.noteManualScroll();
  ok(h.follow.following === false, 'wheel scroll turns following off');
  h.advance(1000);
  h.follow.noteManualScroll();
  ok(h.follow.persistent === false, 'wheel below threshold stays non-persistent');
  h.advance(RESUME_MS - 1);
  ok(h.follow.following === false, 'wheel keeps manual view during idle window');
  h.advance(1);
  ok(h.follow.following === true, 'wheel resumes following after idle delay');
}
{
  const h = harness();
  for (let t = 0; t <= 3200; t += 400) {
    h.follow.noteManualScroll();
    h.advance(400);
  }
  ok(h.follow.persistent === true, 'sustained wheel scrolling enters persistent mode');
  ok(h.follow.following === false, 'sustained wheel keeps following off');
  h.advance(RESUME_MS * 5);
  ok(h.follow.following === false, 'persistent wheel mode ignores idle');
}

// —— 手势中的滚动事件不排恢复定时器 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.follow.noteManualScroll();
  h.advance(200);
  ok(h.pending() === 0, 'scroll during gesture arms no resume timer');
  h.follow.endGesture();
  ok(h.pending() === 1, 'release arms the idle resume timer');
}

// —— 触屏滚动：pointercancel 先结束手势，touchmove 仍续着同一轮手动控制 ——
// 拖动途中不得因空闲超时把面板拽回去。
{
  const h = harness();
  h.follow.beginGesture(); // touchstart / pointerdown
  h.advance(200);
  h.follow.endGesture(); // pointercancel：浏览器接管滚动
  let resumed = false;
  for (let elapsed = 0; elapsed < 3600; elapsed += 400) {
    h.follow.noteManualScroll(); // touchmove
    h.advance(400);
    if (h.follow.following) resumed = true;
  }
  ok(!resumed, 'continuous touch scrolling never resumes mid-drag');
  ok(h.follow.persistent === true, 'long touch scroll enters persistent mode');
  ok(h.follow.autoCenter === false, 'auto-center blocked for the whole drag');
}

// —— 显式恢复：回到跟随，清持久，且不影响后续手势判定 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.advance(SUSTAINED_MS + 200);
  h.follow.endGesture();
  ok(h.follow.persistent === true, 'setup: persistent');
  h.advance(RESUME_MS * 3);
  h.follow.resume();
  ok(h.follow.following === true, 'explicit resume restores following');
  ok(h.follow.persistent === false, 'explicit resume clears persistent mode');
  ok(h.pending() === 0, 'explicit resume clears pending timers');
  h.follow.beginGesture();
  h.advance(400);
  h.follow.endGesture();
  ok(h.follow.persistent === false, 'after resume a brief gesture is brief again');
  h.advance(RESUME_MS);
  ok(h.follow.following === true, 'after resume, brief gesture still auto-resumes');
}

// —— 手势中按下「回到当前」：恢复跟随并清状态 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.follow.resume();
  ok(h.follow.following === true, 'resume works even mid-gesture');
  ok(h.follow.persistent === false, 'mid-gesture resume clears persistent');
  ok(h.follow.autoCenter === false, 'mid-gesture resume still blocks auto-center until release');
  h.follow.endGesture();
  ok(h.follow.autoCenter === true, 'auto-center returns once the finger is lifted');
  h.advance(RESUME_MS * 2);
  ok(h.follow.following === true, 'stays following after mid-gesture resume');
}

// —— onChange 快照 & destroy 清定时器 ——
{
  const h = harness();
  h.follow.beginGesture();
  h.follow.endGesture();
  ok(h.changes.length >= 2, 'onChange notified on transitions');
  const last = h.changes[h.changes.length - 1];
  ok(last.following === false && last.persistent === false, 'onChange snapshot reflects state');
  ok(last.autoCenter === false, 'onChange snapshot carries the auto-center gate');
  h.follow.destroy();
  ok(h.pending() === 0, 'destroy clears pending timers');
  h.advance(RESUME_MS * 2);
  ok(h.follow.following === false, 'destroyed instance never auto-resumes');
}

// —— 时间倒退/同一时刻重复事件不炸 ——
{
  const h = harness();
  h.follow.beginGesture(0);
  h.follow.endGesture(0);
  ok(h.follow.persistent === false, 'zero-length gesture is not sustained');
  h.follow.noteManualScroll(0);
  ok(h.follow.following === false, 'same-instant wheel keeps manual view');
}

console.log(`lyrics-follow: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
