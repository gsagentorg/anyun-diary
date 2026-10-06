---
title: 安允日记 · 歌单时间线
---

<script lang="ts">
  import data from '$lib/data.json';
  import Timeline from '$lib/Timeline.svelte';
  import DayStrip from '$lib/DayStrip.svelte';
  import Heatmap from '$lib/Heatmap.svelte';

  const variants = ['泳道时间轴', '日卡片', '热力图'] as const;
  let current = $state(0);

  const recordings = data.recordings;
</script>

<div class="mx-auto max-w-6xl px-4 py-8">
  <header class="mb-8">
    <h1 class="text-3xl font-bold tracking-tight">安允日记</h1>
    <p class="mt-1 text-sm opacity-70">
      直播歌单时间线 · 数据由文件名 + 元数据自动生成 · 识别结果可能不准确
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
