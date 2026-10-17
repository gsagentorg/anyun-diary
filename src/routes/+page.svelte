<script lang="ts">
  import data from '$lib/data.json';
  import Timeline from '$lib/Timeline.svelte';
  import DayStrip from '$lib/DayStrip.svelte';
  import Heatmap from '$lib/Heatmap.svelte';
  import { player, adopt } from '$lib/player.svelte';
  import Playlist from '$lib/Playlist.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import { tracksInRange, dayStartOf, validRange } from '$lib/playlist-core';
  import type { Recording } from '$lib/types';
  import { page } from '$app/state';
  import { ListMusic } from 'lucide-svelte';

  const variants = ['泳道时间轴', '日卡片', '热力图'] as const;
  let current = $state(0);

  // 缺字段的录像（未导出切片/无时长）补空数组，避免组件里 undefined.length
  const recordings: Recording[] = (data.recordings as Recording[]).map((r) => ({
    ...r,
    duration: r.duration ?? null,
    segments: r.segments ?? [],
    clips: r.clips ?? [],
  }));

  // URL 查询参数 ?from=YYYY-MM-DD&to=YYYY-MM-DD → 自动生成播放列表（不自动开播，只装载）
  let plOpen = $state(false);
  const qFrom = $derived(page.url.searchParams.get('from') ?? '');
  const qTo = $derived(page.url.searchParams.get('to') ?? '');
  const qValid = $derived(!!(qFrom && qTo && validRange(qFrom, qTo)));

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
      <div class="min-w-0">
        <h1 class="text-lg font-bold tracking-tight leading-none">安允日记</h1>
        <p class="mt-1 hidden text-xs opacity-60 lg:block">
          直播歌单时间线 · 数据由文件名 + 切片元数据自动生成
        </p>
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

  <Sheet open={plOpen} onClose={() => (plOpen = false)} title="播放列表">
    <Playlist {recordings} bind:open={plOpen} />
  </Sheet>

  {#if current === 0}
    <Timeline recordings={recordings} />
  {:else if current === 1}
    <DayStrip recordings={recordings} />
  {:else}
    <Heatmap recordings={recordings} />
  {/if}
</div>
