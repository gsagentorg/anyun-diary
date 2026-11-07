<script lang="ts">
  import type { Recording } from './types';
  import { shDayStart } from './playlist-core';
  import { fmtDur, dateCard } from './types';
  import { adopt, buildRecTracks } from './player.svelte.ts';
  import { theme } from './theme.svelte.ts';
  import StateHint from './components/StateHint.svelte';
  import { browser } from '$app/environment';

  let { recordings }: { recordings: Recording[] } = $props();

  interface Cell {
    day: number;       // 当天 0 点 epoch
    hour: number;      // 0-23
    seconds: number;   // 该小时唱歌总秒数
    count: number;     // 歌数
    dayRecs: Recording[];
  }

  const md = (epoch: number) =>
    new Date(epoch * 1000).toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    });

  // 范围选择：独立于歌单生成的 range；本地记忆（anyun-heat-range-v1），刷新保留
  const HEAT_KEY = 'anyun-heat-range-v1';
  let from = $state('');
  let to = $state('');
  $effect(() => {
    if (!browser) return;
    try {
      const raw = localStorage.getItem(HEAT_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { from?: unknown; to?: unknown };
        if (typeof v.from === 'string') from = v.from;
        if (typeof v.to === 'string') to = v.to;
      }
    } catch { /* 忽略 */ }
  });
  $effect(() => {
    if (!browser) return;
    try {
      localStorage.setItem(HEAT_KEY, JSON.stringify({ from, to }));
    } catch { /* 配额/隐私模式静默 */ }
  });

  // YYYY-MM-DD（上海时区）
  const dayStr = (epoch: number) =>
    new Date(epoch * 1000).toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' });

  function presetDays(n: number) {
    const today = shDayStart(Date.now() / 1000);
    from = dayStr(today - (n - 1) * 86400);
    to = dayStr(today);
  }

  function clearRange() {
    from = '';
    to = '';
  }

  // 按范围过滤（录像按上海日界归天；空串 = 不限）
  const filtered = $derived.by(() => {
    const fromDay = from ? shDayStart(Date.parse(from + 'T00:00:00+08:00') / 1000) : null;
    const toDay = to ? shDayStart(Date.parse(to + 'T00:00:00+08:00') / 1000) : null;
    if (fromDay === null && toDay === null) return recordings;
    return recordings.filter((r) => {
      const d = shDayStart(r.start);
      if (fromDay !== null && d < fromDay) return false;
      if (toDay !== null && d > toDay) return false;
      return true;
    });
  });

  // 时长分层档位（秒）
  const DUR_BOUNDS = [60, 180, 300, 600];
  const DUR_LABELS = ['<1分钟', '1–3分钟', '3–5分钟', '5–10分钟', '≥10分钟'];

  // 范围内统计：次数 / 总时长 / 平均（总体）
  const stats = $derived.by(() => {
    const buckets = DUR_LABELS.map((label) => ({ label, count: 0, seconds: 0 }));
    let count = 0;
    let seconds = 0;
    for (const rec of filtered) {
      for (const c of rec.clips ?? []) {
        const dur = c.offsetEnd - c.offsetStart;
        if (dur <= 0) continue;
        count += 1;
        seconds += dur;
        let bi = DUR_BOUNDS.findIndex((b) => dur < b);
        if (bi < 0) bi = DUR_BOUNDS.length;
        buckets[bi].count += 1;
        buckets[bi].seconds += dur;
      }
    }
    return { count, seconds, avg: count > 0 ? seconds / count : 0, buckets };
  });

  // 聚合：天 × 小时 → 唱歌秒数（切片跨小时时按占比拆分）
  const { days, cells, maxSeconds } = $derived.by(() => {
    const cellMap = new Map<string, Cell>();
    const daySet = new Map<number, Recording[]>();
    for (const rec of filtered) {
      const day = shDayStart(rec.start);
      const arr = daySet.get(day) ?? [];
      arr.push(rec);
      daySet.set(day, arr);
      for (const c of rec.clips ?? []) {
        let s = rec.start + c.offsetStart;
        const end = rec.start + c.offsetEnd;
        while (s < end) {
          const day = shDayStart(s);
          const hour = Math.min(23, Math.max(0, Math.floor((s - day) / 3600)));
          const hourEnd = day + (hour + 1) * 3600;
          const seg = Math.min(end, hourEnd) - s;
          const key = day + '|' + hour;
          const cell = cellMap.get(key) ?? { day, hour, seconds: 0, count: 0, dayRecs: [] };
          cell.seconds += seg;
          cell.count += 1;
          cellMap.set(key, cell);
          s = hourEnd;
        }
      }
    }
    const days = [...daySet.keys()].sort((a, b) => a - b);
    const cells = [...cellMap.values()];
    for (const c of cells) c.dayRecs = daySet.get(c.day) ?? [];
    const maxSeconds = Math.max(1, ...cells.map((c) => c.seconds));
    return { days, cells, maxSeconds };
  });

  const cellAt = (day: number, hour: number) => cells.find((c) => c.day === day && c.hour === hour);

  let tip = $state<{ x: number; y: number; html: string } | null>(null);
  function show(e: MouseEvent, c: Cell) {
    tip = {
      x: e.clientX, y: e.clientY,
      html: `<b>${md(c.day)} ${String(c.hour).padStart(2, '0')}:00–${String(c.hour + 1).padStart(2, '0')}:00</b><br>${c.count} 首 · 唱了 ${fmtDur(c.seconds)}`,
    };
  }

  function bg(c: Cell | undefined): string {
    if (!c || c.seconds <= 0) return 'hsl(0 0% 50% / 0.12)';
    const r = Math.min(1, c.seconds / maxSeconds);
    const hsl = theme.resolved === 'dark' ? 'hsl(258 90% 72%' : 'hsl(258 80% 60%';
    return `${hsl} / ${0.15 + 0.8 * r})`;
  }

  function playDay(c: Cell) {
    const tracks = c.dayRecs
      .flatMap((r) => buildRecTracks(r))
      .sort((a, b) => a.rec.start + a.clip.offsetStart - (b.rec.start + b.clip.offsetStart));
    if (tracks.length) adopt(tracks, 0);
  }
</script>

<!-- 范围选择（独立于歌单生成的日期；带本地记忆） -->
<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
  <span class="opacity-55">范围</span>
  <input
    type="date"
    bind:value={from}
    aria-label="开始日期"
    class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums"
  />
  <span class="opacity-55">→</span>
  <input
    type="date"
    bind:value={to}
    aria-label="结束日期"
    class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums"
  />
  <button
    type="button"
    class="rounded border border-base-300 px-2 py-1 text-2xs transition hover:border-accent"
    onclick={clearRange}
  >全部</button>
  <button
    type="button"
    class="rounded border border-base-300 px-2 py-1 text-2xs transition hover:border-accent"
    onclick={() => presetDays(7)}
  >近7天</button>
  <button
    type="button"
    class="rounded border border-base-300 px-2 py-1 text-2xs transition hover:border-accent"
    onclick={() => presetDays(30)}
  >近30天</button>
</div>

<!-- 统计：活跃天数 / 次数 / 总时长 / 平均（总体） -->
<div class="mt-2 flex flex-wrap gap-1.5 text-2xs">
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">活跃 {days.length} 天</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">共 {stats.count} 首</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">总时长 {fmtDur(stats.seconds)}</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">平均 {stats.count > 0 ? fmtDur(stats.avg) : '–'}/首</span>
</div>

<div class="mt-3 overflow-x-auto">
  {#if days.length === 0}
    <StateHint kind="no-data" />
  {:else}
    <div class="min-w-[640px]">
      <!-- 列头：MM/DD + 周几 -->
      <div class="flex">
        <div class="w-10 shrink-0"></div>
        <div class="flex flex-1 gap-1">
          {#each days as day (day)}
            {@const dc = dateCard(day)}
            <div class="flex min-w-0 flex-1 flex-col items-center">
              <span class="text-2xs font-semibold tabular-nums">{dc.md}</span>
              <span class="text-2xs opacity-55">{dc.wd}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- 主体：每列一天，每行一小时 -->
      <div class="mt-1 flex">
        <div class="flex w-10 shrink-0 flex-col gap-1">
          {#each Array(24) as _, h}
            <div class="flex h-3.5 items-center justify-end pr-1 text-2xs tabular-nums opacity-55">
              {String(h).padStart(2, '0')}
            </div>
          {/each}
        </div>

        <div class="flex flex-1 gap-1">
          {#each days as day (day)}
            <div class="flex flex-1 flex-col gap-1">
              {#each Array(24) as _, h}
                {@const c = cellAt(day, h)}
                <div
                  class="h-3.5 w-full rounded-sm transition hover:ring-1 ring-accent"
                  style:background={bg(c)}
                  role={c ? 'button' : undefined}
                  tabindex={c ? 0 : undefined}
                  onclick={c ? () => playDay(c) : undefined}
                  title={c ? "用这一天的歌替换播放列表" : undefined}
                  onkeydown={(e) => { if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playDay(c); } }}
                  onmousemove={(e) => c && show(e, c)}
                  onmouseleave={() => (tip = null)}
                ></div>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <!-- 图例 -->
      <div class="mt-4 flex items-center gap-2 pl-10">
        <span class="text-2xs opacity-55">少</span>
        <div
          class="h-2 w-24 rounded-full"
          style:background={
            theme.resolved === 'dark'
              ? 'linear-gradient(90deg, hsl(258 90% 72% / 0.15), hsl(258 90% 72% / 0.95))'
              : 'linear-gradient(90deg, hsl(258 80% 60% / 0.15), hsl(258 80% 60% / 0.95))'
          }
        ></div>
        <span class="text-2xs opacity-55">多</span>
        <span class="ml-2 text-2xs opacity-55">点击格子装载当天播放列表</span>
      </div>
    </div>
  {/if}
</div>

{#if days.length > 0}
  <!-- 平均时长：按时长分层 -->
  <div class="mt-3 overflow-x-auto">
    <table class="w-full min-w-[420px] text-left text-2xs">
      <thead>
        <tr class="opacity-55">
          <th scope="col" class="py-1 pr-3 font-normal">时长档</th>
          <th scope="col" class="py-1 pr-3 font-normal">首数</th>
          <th scope="col" class="py-1 pr-3 font-normal">占比</th>
          <th scope="col" class="py-1 font-normal">平均时长</th>
        </tr>
      </thead>
      <tbody class="tabular-nums">
        {#each stats.buckets as b (b.label)}
          <tr class="border-t border-base-300">
            <td class="py-1 pr-3">{b.label}</td>
            <td class="py-1 pr-3">{b.count}</td>
            <td class="py-1 pr-3">{stats.count > 0 ? Math.round((b.count / stats.count) * 100) + '%' : '–'}</td>
            <td class="py-1">{b.count > 0 ? fmtDur(b.seconds / b.count) : '–'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-base-300 bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
