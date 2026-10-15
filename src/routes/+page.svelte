<script lang="ts">
  import data from '$lib/data.json';
  import Timeline from '$lib/Timeline.svelte';
  import DayStrip from '$lib/DayStrip.svelte';
  import Heatmap from '$lib/Heatmap.svelte';
  import { player, adopt } from '$lib/player.svelte';
  import Playlist from '$lib/Playlist.svelte';
  import { tracksInRange, dayStartOf, validRange } from '$lib/playlist.svelte';
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

<div class="mx-auto max-w-6xl px-4 py-8 {player.track ? 'pb-32' : ''}">
  <header class="mb-8">
    <h1 class="text-3xl font-bold tracking-tight">安允日记</h1>
    <p class="mt-1 text-sm opacity-70">
      直播歌单时间线 · 数据由文件名 + 切片元数据自动生成
    </p>
    <nav class="mt-4 flex gap-2">
      {#each variants as v, i}
        <button
          class="rounded-full px-3 py-1 text-sm border transition"
          class:border-accent={i === current}
          class:opacity-50={i !== current}
          onclick={() => (current = i)}
        >
          {v}
        </button>
      {/each}
    </nav>
    <button
      class="mt-3 flex items-center gap-1.5 rounded-full border border-base-300 px-3 py-1 text-sm transition hover:bg-base-200"
      onclick={() => (plOpen = !plOpen)}
      class:border-accent={plOpen}
      aria-expanded={plOpen}
    >
      <ListMusic class="h-4 w-4" /> 播放列表
    </button>
  </header>

  {#if plOpen}
    <div class="mb-6">
      <Playlist {recordings} bind:open={plOpen} />
    </div>
  {/if}

  {#if current === 0}
    <Timeline recordings={recordings} />
  {:else if current === 1}
    <DayStrip recordings={recordings} />
  {:else}
    <Heatmap recordings={recordings} />
  {/if}
</div>
