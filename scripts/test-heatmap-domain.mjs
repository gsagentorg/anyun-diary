import assert from 'node:assert/strict';
import { heatActiveDayCount, heatDomainDays, todayStart } from '../src/lib/heatmap-domain.ts';
import { shDayStart } from '../src/lib/playlist-core.ts';

const DAY = 86400;
const at = (iso) => Date.parse(iso) / 1000;
const day = (iso) => shDayStart(at(iso));
const fmt = (epoch) => new Date((epoch + 28800) * 1000).toISOString().slice(0, 10);

let checks = 0;
const ck = (name, fn) => {
  checks++;
  fn();
  console.log(`PASS ${name}`);
};

const labels = (days) => days.map(fmt);

// ---------- 1. 数据止于过去某日：域仍到今天，今天为空列 ----------
ck('数据止于 11-18、今天 11-20 → 域含 11-20/19 空列', () => {
  const today = at('2026-11-20T12:34:56+08:00');
  const active = [day('2026-11-18T21:00:00+08:00'), day('2026-11-17T09:00:00+08:00')];
  const domain = heatDomainDays(active, { today });
  assert.deepEqual(labels(domain), ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17']);
  assert.equal(domain.includes(day('2026-11-20T00:00:00+08:00')), true, '今天必须出现');
  assert.equal(active.includes(domain[0]), false, '今天不得被伪造成活动日');
  assert.equal(heatActiveDayCount(active), 2, '活跃天数不含空列');
});

// ---------- 2. 今天有数据：列仍只出现一次 ----------
ck('今天有数据时域首列就是今天且不重复', () => {
  const today = at('2026-11-20T08:00:00+08:00');
  const active = [day('2026-11-20T07:30:00+08:00'), day('2026-11-19T23:00:00+08:00')];
  const domain = heatDomainDays(active, { today });
  assert.deepEqual(labels(domain), ['2026-11-20', '2026-11-19']);
});

// ---------- 3. 跨月边界 ----------
ck('跨月：数据止于 10-30、今天 11-02 → 补 11-01/10-31', () => {
  const today = at('2026-11-02T09:00:00+08:00');
  const domain = heatDomainDays([day('2026-10-30T22:00:00+08:00')], { today });
  assert.deepEqual(labels(domain), ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
});

ck('跨年：今天 2027-01-01、数据止于 2026-12-30', () => {
  const today = at('2027-01-01T00:05:00+08:00');
  const domain = heatDomainDays([day('2026-12-30T23:00:00+08:00')], { today });
  assert.deepEqual(labels(domain), ['2027-01-01', '2026-12-31', '2026-12-30']);
});

ck('上海日界：UTC 仍在 11-19 时按上海算 11-20', () => {
  const today = at('2026-11-19T17:30:00Z'); // = 2026-11-20 01:30 +08
  assert.deepEqual(labels(heatDomainDays([day('2026-11-18T10:00:00+08:00')], { today })), ['2026-11-20', '2026-11-19', '2026-11-18']);
});

// ---------- 4. 域内无数据日：连续、空列、不跳 ----------
ck('中间空日也出列（不跳过）', () => {
  const today = at('2026-11-20T12:00:00+08:00');
  const domain = heatDomainDays([day('2026-11-20T09:00:00+08:00'), day('2026-11-16T09:00:00+08:00')], { today });
  assert.deepEqual(labels(domain), ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16']);
  assert.equal(domain.length, 5, '空日不得被跳过');
});

// ---------- 5. 结束日期筛选：域尾夹到筛选日，但永不越过今天 ----------
ck('筛选结束日为过去 → 域尾是筛选日', () => {
  const today = at('2026-11-20T12:00:00+08:00');
  const domain = heatDomainDays([day('2026-10-30T09:00:00+08:00')], { today, end: day('2026-10-31T00:00:00+08:00') });
  assert.deepEqual(labels(domain), ['2026-10-31', '2026-10-30']);
});
ck('筛选结束日在未来 → 仍夹到今天', () => {
  const today = at('2026-11-20T12:00:00+08:00');
  const domain = heatDomainDays([day('2026-11-19T09:00:00+08:00')], { today, end: day('2027-01-01T00:00:00+08:00') });
  assert.deepEqual(labels(domain), ['2026-11-20', '2026-11-19']);
});

// ---------- 6. 无数据 / 脏输入 ----------
ck('无活动日 → 空域（调用方保留无数据提示）', () => assert.deepEqual(heatDomainDays([], { today: at('2026-11-20T12:00:00+08:00') }), []));
ck('乱序/重复输入归一', () => {
  const today = at('2026-11-20T12:00:00+08:00');
  const a = day('2026-11-18T09:00:00+08:00');
  const b = day('2026-11-17T09:00:00+08:00');
  const domain = heatDomainDays([b, a, b, a], { today });
  assert.deepEqual(labels(domain), ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17']);
});

// ---------- 7. 结构约定：严格降序、整日步进、对齐上海零点 ----------
ck('域严格降序、步进 1 天、对齐上海 0 点', () => {
  const today = at('2026-11-20T12:00:00+08:00');
  const domain = heatDomainDays([day('2026-11-02T09:00:00+08:00')], { today });
  for (let i = 0; i < domain.length; i++) {
    assert.equal(domain[i] % DAY, day('2026-01-01T00:00:00+08:00') % DAY, '必须对齐上海日界');
    if (i > 0) assert.equal(domain[i - 1] - domain[i], DAY, '步进必须是一天');
  }
  assert.equal(todayStart(today), domain[0]);
});

console.log(`heatmap domain tests passed (${checks} checks): domain always ends today, empty tail cells, month/year boundary, filter clamp`);