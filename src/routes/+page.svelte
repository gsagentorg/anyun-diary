<script lang="ts">
  import data from '$lib/data.json';
  import Timeline from '$lib/Timeline.svelte';
  import DayStrip from '$lib/DayStrip.svelte';
  import Heatmap from '$lib/Heatmap.svelte';
  import { player, adopt } from '$lib/player.svelte';
  import Playlist from '$lib/Playlist.svelte';
  import { tracksInRange, dayStartOf, validRange } from '$lib/playlist-core';
  import type { Recording } from '$lib/types';
  import { page } from '$app/state';
  import { ListMusic } from 'lucide-svelte';
  import Chip from '$lib/components/Chip.svelte';

  const variants = ['泳道时间轴', '日卡片', '热力图'] as const;
  let current = $state(0);

  // 直播间状态
  type LiveInfo = {
    live: boolean | null;
    title: string | null;
    area: string | null;
    cover: string | null;
    checkedAt: string;
  };
  const LIVE_URL = 'https://live.bilibili.com/1732283852';
  let liveInfo = $state<LiveInfo | null>(null);

  $effect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      try {
        const res = await fetch('/api/live');
        liveInfo = (await res.json()) as LiveInfo;
      } catch {
        liveInfo = null;
      }
    };
    load();
    id = setInterval(load, 60_000);
    return () => clearInterval(id);
  });

  // 缺字段的录像（未导出切片/无时长）补空数组，避免组件里 undefined.length
  const recordings: Recording[] = (data.recordings as Recording[]).map((r) => ({
    ...r,
    duration: r.duration ?? null,
    segments: r.segments ?? [],
    clips: r.clips ?? [],
  }));

  // URL 查询参数 ?from=YYYY-MM-DD&to=YYYY-MM-DD → 自动生成播放列表（不自动开播，只装载）
  let plOpen = $state(true);
  const qFrom = $derived(page.url.searchParams.get('from') ?? '');
  const qTo = $derived(page.url.searchParams.get('to') ?? '');
  const qValid = $derived(!!(qFrom && qTo && validRange(qFrom, qTo)));
  const laneMode = $derived(
    page.url.searchParams.get('lane') === 'linear' ? 'linear' : 'compress',
  );

  $effect(() => {
    if (!qValid || player.playlist.length > 0) return;
    const lo = dayStartOf(qFrom)!;
    const hi = dayStartOf(qTo)! + 86400;
    const tracks = tracksInRange(recordings, lo, hi);
    if (tracks.length > 0) {
      plOpen = true;
      player.playlist = tracks;
      player.pos = -1;
    }
  });
</script>

<div class="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 {player.track ? 'pb-32' : ''}">
  <header
    class="sticky top-0 z-30 -mx-4 mb-4 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur sm:-mx-6 sm:mb-6 sm:px-6 lg:-mx-8 lg:px-8"
  >
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div class="flex items-center gap-2">
        <img
          src="/brand/avatar.jpg"
          alt="安允日记"
          class="h-8 w-8 shrink-0 rounded-full border border-base-300 object-cover"
        />
        <div class="min-w-0">
          <h1 class="text-lg font-bold tracking-tight leading-none">安允日记</h1>
          <p class="mt-1 hidden text-xs opacity-60 lg:block">
            直播歌单时间线 · 数据由文件名 + 切片元数据自动生成
          </p>
        </div>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap items-center gap-2" role="tablist" aria-label="视图切换">
          {#each variants as v, i}
            <button
              role="tab"
              aria-selected={i === current}
              class="rounded-full border px-3 py-1 text-sm transition {i === current
                ? 'border-accent text-accent'
                : 'border-base-300 opacity-60 hover:opacity-100'}"
              onclick={() => (current = i)}
            >
              {v}
            </button>
          {/each}
        </div>
        <button
          class="flex items-center gap-1.5 rounded-full border border-base-300 px-3 py-1 text-sm transition hover:bg-base-200 {plOpen
            ? 'border-accent text-accent'
            : ''}"
          onclick={() => (plOpen = !plOpen)}
          aria-expanded={plOpen}
        >
          <ListMusic class="h-4 w-4" /> 播放列表
        </button>
      </div>
    </div>
  </header>

  <div class="mb-4 flex flex-col gap-4 sm:mb-6 lg:flex-row lg:items-start">
  <section class="lg:w-[38%]" aria-label="直播间">
    {#if liveInfo && liveInfo.live === true}
      <div class="flex items-center gap-2 rounded-lg border border-base-300 px-3 py-2">
        <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500"></span>
        <Chip variant="warning">直播中</Chip>
        <span class="min-w-0 truncate text-sm font-medium">{liveInfo.title ?? '安允日记'}</span>
        <a
          href={LIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto shrink-0 rounded-full border border-accent px-3 py-1 text-2xs text-accent transition hover:bg-base-200"
        >
          去直播间
        </a>
      </div>
    {:else if liveInfo && liveInfo.live === false}
      <div class="flex items-center gap-3 rounded-lg border border-base-300 px-3 py-2">
        <img
          src="/brand/cover.jpg"
          alt="直播间封面"
          class="h-9 w-16 shrink-0 rounded-md object-cover"
        />
        <span class="shrink-0 text-sm">未开播</span>
        {#if liveInfo.title}
          <span class="min-w-0 truncate text-2xs opacity-60">最近：{liveInfo.title}</span>
        {/if}
        <a
          href={LIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto shrink-0 rounded-full border border-accent px-3 py-1 text-2xs text-accent transition hover:bg-base-200"
        >
          去直播间
        </a>
      </div>
    {/if}
  </section>

  <div class="lg:flex-1">
    {#if plOpen}
      <div class="max-h-[60vh] overflow-y-auto rounded-lg border border-base-300 bg-base-100">
        <Playlist {recordings} bind:open={plOpen} />
      </div>
    {:else}
      <button
        class="flex w-full items-center justify-between rounded-lg border border-base-300 bg-base-100 px-4 py-2 text-sm transition hover:border-accent"
        onclick={() => (plOpen = true)}
        aria-expanded={plOpen}
      >
        <span class="flex items-center gap-1.5"><ListMusic class="h-4 w-4" /> 播放列表</span>
        <span class="text-xs opacity-60">展开</span>
      </button>
    {/if}
  </div>
  </div>

  {#if current === 0}
    <Timeline recordings={recordings} laneMode={laneMode} />
  {:else if current === 1}
    <DayStrip recordings={recordings} />
  {:else}
    <Heatmap recordings={recordings} />
  {/if}
</div>
