<script lang="ts">
  import data from '$lib/data.json';
  import Timeline from '$lib/Timeline.svelte';
  import DayStrip from '$lib/DayStrip.svelte';
  import Heatmap from '$lib/Heatmap.svelte';
  import { player } from '$lib/player.svelte';
  import type { Recording } from '$lib/types';

  const variants = ['泳道时间轴', '日卡片', '热力图'] as const;
  let current = $state(0);

  // 缺字段的录像（未导出切片/无时长）补空数组，避免组件里 undefined.length
  const recordings: Recording[] = (data.recordings as Recording[]).map((r) => ({
    ...r,
    duration: r.duration ?? null,
    segments: r.segments ?? [],
    clips: r.clips ?? [],
  }));
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
  </header>

  {#if current === 0}
    <Timeline recordings={recordings} />
  {:else if current === 1}
    <DayStrip recordings={recordings} />
  {:else}
    <Heatmap recordings={recordings} />
  {/if}
</div>
