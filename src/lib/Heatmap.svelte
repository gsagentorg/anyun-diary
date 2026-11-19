<script lang="ts">
  import type { Audio } from './types';
  import { shDayStart } from './playlist-core';
  import { fmtDur, dateCard } from './types';
  import {loadMonth} from './backend.svelte';
  import { adopt, makeTrack } from './player.svelte.ts';
  import { theme } from './theme.svelte.ts';
  import StateHint from './components/StateHint.svelte';
  import {onMount} from 'svelte';
  import { browser } from '$app/environment';

  let { audios, onOlder=()=>{}, from=$bindable(''), to=$bindable('') }: { audios: Audio[]; onOlder?:()=>void; from?:string; to?:string } = $props();

  interface Cell {
    day: number;       // 当天 0 点 epoch
    hour: number;      // 0-23
    seconds: number;   // 该小时唱歌总秒数
    count: number;     // 歌数
    dayAudios: Audio[];
  }

  const md = (epoch: number) =>
    new Date(epoch * 1000).toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    });

  // 范围选择：独立于歌单生成的 range；本地记忆（anyun-heat-range-v1），刷新保留
  const HEAT_KEY = 'anyun-heat-range-v1';

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

  // 仅筛选已加载音频（上海日界；空串 = 当前已加载窗口）
  const filtered = $derived.by(() => {
    const fromDay = from ? shDayStart(Date.parse(from + 'T00:00:00+08:00') / 1000) : null;
    const toDay = to ? shDayStart(Date.parse(to + 'T00:00:00+08:00') / 1000) : null;
    if (fromDay === null && toDay === null) return audios;
    return audios.filter((r) => {
      const d = shDayStart(r.startAt);
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
    let unknown = 0;
    for (const audio of filtered) {
      const dur = audio.duration;
      if (dur === null || dur <= 0) { unknown++; continue; }
      count++; seconds += dur;
      let bi = DUR_BOUNDS.findIndex((bound) => dur < bound);
      if (bi < 0) bi = DUR_BOUNDS.length;
      buckets[bi].count++; buckets[bi].seconds += dur;
    }
    return { count, seconds, unknown, avg: count > 0 ? seconds / count : 0, buckets };
  });

  // 聚合：天 × 小时 → 唱歌秒数（切片跨小时时按占比拆分）
  const { days, cells, maxSeconds } = $derived.by(() => {
    const cellMap = new Map<string, Cell>();
    const daySet = new Map<number, Audio[]>();
    const addDay = (day: number, audio: Audio) => {
      const list = daySet.get(day) ?? [];
      if (!list.some((a) => a.id === audio.id)) list.push(audio);
      daySet.set(day, list);
    };
    for (const audio of filtered) {
      addDay(shDayStart(audio.startAt), audio);
      let s = audio.startAt;
      const end = s + (audio.duration ?? 0);
      while (s < end) {
        const day = shDayStart(s);
        addDay(day, audio);
        const hour = Math.floor((s - day) / 3600);
        const hourEnd = day + (hour + 1) * 3600;
        const key = day + '|' + hour;
        const cell = cellMap.get(key) ?? { day, hour, seconds: 0, count: 0, dayAudios: [] };
        cell.seconds += Math.min(end, hourEnd) - s;
        cell.count++;
        cellMap.set(key, cell);
        s = hourEnd;
      }
    }
    const days = [...daySet.keys()].sort((a, b) => b - a);
    const cells = [...cellMap.values()];
    for (const c of cells) c.dayAudios = daySet.get(c.day) ?? [];
    const maxSeconds = Math.max(1, ...cells.map((c) => c.seconds));
    return { days, cells, maxSeconds };
  });

  let scroller=$state<HTMLDivElement>();let left=$state(0),width=$state(1000);
  const columnWidth=48;
  const firstColumn=$derived(Math.max(0,Math.floor(left/columnWidth)-8));
  const visibleDays=$derived(days.slice(firstColumn,firstColumn+Math.ceil(width/columnWidth)+16));
  function olderSentinel(node:HTMLElement){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))onOlder();},{root:scroller??null,rootMargin:'0px'});observer.observe(node);return {destroy:()=>observer.disconnect()};}
  function heatScroll(){left=scroller?.scrollLeft??0;}
  onMount(()=>{width=scroller?.clientWidth??1000;});  const cellIndex = $derived(new Map(cells.map((c) => [c.day + '|' + c.hour, c])));
  const cellAt = (day: number, hour: number) => cellIndex.get(day + '|' + hour);

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

  async function playDay(c: Cell) {
    const full=await loadMonth(c.dayAudios[0].monthId);
    const tracks = full.filter(a=>shDayStart(a.startAt)===c.day)
      .sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id))
      .map(makeTrack);
    if (tracks.length) adopt(tracks, 0);
  }
</script>

<div class="py-2" data-heat-controls>
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
  >已加载全部</button>
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

<p class="mt-1 text-2xs opacity-60">统计范围：已加载音频（日期筛选不代表全目录）</p>
<!-- 统计：活跃天数 / 次数 / 总时长 / 平均（总体） -->
<div class="mt-2 flex flex-wrap gap-1.5 text-2xs">
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">活跃 {days.length} 天</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">共 {filtered.length} 首</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">已知总时长 {fmtDur(stats.seconds)}</span>
  <span class="rounded-full border border-base-300 px-2 py-0.5 tabular-nums">平均 {stats.count > 0 ? fmtDur(stats.avg) : '–'}/首</span>
</div>


</div>
<div class="mt-3 overflow-x-auto" bind:this={scroller} onscroll={heatScroll} bind:clientWidth={width} data-heat-scroll>
  {#if days.length === 0}
    <StateHint kind="no-data" />
  {:else}
    <div style:width={Math.max(640,days.length*columnWidth+80)+'px'}>
      <!-- 列头：MM/DD + 周几 -->
      <div class="flex">
        <div class="w-10 shrink-0"></div>
        <div class="flex flex-1 gap-1">
          <div style:width={firstColumn*columnWidth+'px'} class="shrink-0"></div>
          {#each visibleDays as day (day)}
            {@const dc = dateCard(day)}
            <div class="flex w-11 shrink-0 flex-col items-center">
              <span class="text-2xs font-semibold tabular-nums">{dc.md}</span>
              <span class="text-2xs opacity-55">{dc.wd}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- 主体：每列一天，每行一小时 -->
      <div class="mt-1 flex">
        <div class="sticky left-0 z-10 flex w-10 shrink-0 flex-col gap-1 bg-base-100">
          {#each Array(24) as _, h}
            <div class="flex h-3.5 items-center justify-end pr-1 text-2xs tabular-nums opacity-55">
              {String(h).padStart(2, '0')}
            </div>
          {/each}
        </div>

        <div class="flex flex-1 gap-1">
          <div style:width={firstColumn*columnWidth+'px'} class="shrink-0"></div>
          {#each visibleDays as day (day)}
            <div class="flex w-11 shrink-0 flex-col gap-1">
              {#each Array(24) as _, h}
                {@const c = cellAt(day, h)}
                <button
                  type="button"
                  disabled={!c}
                  aria-label={c ? `${md(c.day)} ${c.hour}时：${c.count}首，${fmtDur(c.seconds)}；装载当天播放列表` : `${md(day)} ${h}时无已知时长音频`}
                  class="h-3.5 w-full rounded-sm transition hover:ring-1 ring-accent"
                  style:background={bg(c)}
                  onclick={c ? () => playDay(c) : undefined}
                  title={c ? "用这一天的歌替换播放列表" : undefined}
                  onkeydown={(e) => { if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playDay(c); } }}
                  onmousemove={(e) => c && show(e, c)}
                  onmouseleave={() => (tip = null)}
                ></button>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <div use:olderSentinel class="ml-auto h-1 w-1" aria-label="继续加载热力历史"></div>
    </div>
  {/if}
</div>

{#if days.length > 0}
      <!-- 图例 -->
      <div data-heat-legend class="mt-4 flex flex-wrap items-center gap-2 pl-10">
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

{/if}
{#if days.length > 0}
  {#if stats.unknown}<p class="mt-2 text-xs opacity-60">{stats.unknown} 首时长未知，不计入小时热力、平均和时长分层。</p>{/if}
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
