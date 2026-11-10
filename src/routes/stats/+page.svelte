<script lang="ts">
  import Heatmap from '$lib/Heatmap.svelte';
  import data from '$lib/data.json';
  import { shDayStart, validRange } from '$lib/playlist-core';
  import { fmtDur } from '$lib/types';
  import { browser } from '$app/environment';

  const recordings = data.recordings;

  // 范围选择（本地记忆，键与原热力图一致，刷新保留）
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

  // 与热力图同口径的范围过滤（录像按上海日界归天；空串 = 不限）
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

  interface SongAgg { title: string; count: number; seconds: number }
  // Top 榜：范围内按歌名聚合（次数 / 总时长）
  const topSongs = $derived.by(() => {
    const map = new Map<string, SongAgg>();
    for (const rec of filtered) {
      for (const c of rec.clips ?? []) {
        const dur = c.offsetEnd - c.offsetStart;
        if (dur <= 0) continue;
        const key = c.title || c.file;
        const agg = map.get(key) ?? { title: key, count: 0, seconds: 0 };
        agg.count += 1;
        agg.seconds += dur;
        map.set(key, agg);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.seconds - a.seconds);
  });

  const medal = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1));
</script>

<div class="mx-auto w-full max-w-6xl px-4 py-4">
  <div class="flex items-center gap-3">
    <a href="/" class="text-sm opacity-60 transition hover:opacity-100">← 返回</a>
    <h1 class="text-lg font-bold tracking-tight">统计</h1>
  </div>

  <!-- 范围选择（独立于歌单生成的日期；带本地记忆） -->
  <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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

  <!-- 热力图（含天数/次数/时长统计条） -->
  <div class="mt-2">
    <Heatmap {recordings} {from} {to} />
  </div>

  <!-- 主猫唱得最多的歌 Top 榜 -->
  <section class="mt-6">
    <h2 class="text-sm font-semibold tracking-tight">唱得最多的歌</h2>
    {#if topSongs.length === 0}
      <p class="mt-2 text-xs opacity-55">这个范围里还没有歌</p>
    {:else}
      <ol class="mt-2 flex flex-col gap-1">
        {#each topSongs.slice(0, 20) as s, i (s.title)}
          <li class="flex items-center gap-2 rounded-md border border-base-300 px-2 py-1 text-xs">
            <span class="w-6 shrink-0 text-center tabular-nums" aria-hidden="true">{medal(i)}</span>
            <span class="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
            <span class="shrink-0 tabular-nums opacity-70">{s.count} 次</span>
            <span class="shrink-0 tabular-nums opacity-55">{fmtDur(s.seconds)}</span>
          </li>
        {/each}
      </ol>
      {#if topSongs.length > 20}
        <p class="mt-1 text-2xs opacity-45">仅展示前 20，共 {topSongs.length} 首</p>
      {/if}
    {/if}
  </section>
</div>
