<script lang="ts">
  import type { Recording, Track } from './types';
  import { player, insertRange } from './player.svelte';
  import { tracksInRange, dayStartOf, validRange } from './playlist-core';
  import { onMount } from 'svelte';
  import { fmtDur } from './types';
  import { ListMusic, Plus, Check, Search, X } from 'lucide-svelte';

  let { recordings, open = $bindable(false) }: { recordings: Recording[]; open?: boolean } = $props();

  let from = $state('');
  let to = $state('');
  let error = $state('');

  // 从 URL 查询参数预填，保证链接带上同一范围
  onMount(() => {
    const sp = new URLSearchParams(location.search);
    if (!from) from = sp.get('from') ?? '';
    if (!to) to = sp.get('to') ?? '';
  });

  // 应用时把范围写回 URL（可分享/刷新保持）
  function syncUrl() {
    const sp = new URLSearchParams(location.search);
    if (from) sp.set('from', from); else sp.delete('from');
    if (to) sp.set('to', to); else sp.delete('to');
    history.replaceState(null, '', '?' + sp.toString());
  }

  // 范围预览：from/to 变化时展示 tracksInRange 结果（不再绑定播放队列）
  const preview = $derived.by(() => {
    if (from && to && !validRange(from, to)) return { tracks: [] as Track[], ok: false };
    const lo = from ? dayStartOf(from) : null;
    const hi = to ? dayStartOf(to)! + 86400 : null;
    const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
    return { tracks, ok: tracks.length > 0 };
  });
  const previewTotal = $derived(preview.tracks.reduce(
    (a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart),
    0,
  ));
  const previewTop = $derived(preview.tracks.slice(0, 20));
  const previewRest = $derived(Math.max(0, preview.tracks.length - 20));

  function generate() {
    if (from && to && !validRange(from, to)) {
      error = '范围无效';
      return;
    }
    error = '';
    syncUrl();
    const n = insertRange(preview.tracks);
    if (n === 0) error = '范围内没有切片';
  }

  let addedIdx = $state<number | null>(null);
  let addTimer: ReturnType<typeof setTimeout> | undefined;

  function addToQueue(i: number) {
    insertRange([preview.tracks[i]]);
    addedIdx = i;
    clearTimeout(addTimer);
    addTimer = setTimeout(() => (addedIdx = null), 1200);
  }

</script>

<div class="card rounded-xl border bg-base-100 p-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2 text-sm font-semibold">
      <ListMusic class="h-4 w-4" />
      按时间生成
    </div>
    <button class="rounded p-1 transition hover:bg-base-200" onclick={() => (open = false)} aria-label="收起">
      <X class="h-4 w-4" />
    </button>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
    <input type="date" bind:value={from} class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums" />
    <span class="opacity-50">→</span>
    <input type="date" bind:value={to} class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums" />
    <button
      class="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-accent-content transition hover:opacity-90"
      onclick={generate}
    >
      <Search class="h-3 w-3" /> 生成并插入队列
    </button>
    {#if error}
      <span class="text-warning">{error}</span>
    {/if}
  </div>

  <div class="mt-3 border-t border-base-300 pt-3 text-xs">
    <span class="rounded-full bg-accent/15 px-2 py-0.5 text-2xs tabular-nums opacity-80">
      {preview.tracks.length} 首 · {fmtDur(previewTotal)}
    </span>
    {#if preview.ok}
      <ol class="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
        {#each previewTop as t, i (t.clip.file)}
          <li>
            <button
              type="button"
              class="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition hover:bg-base-200"
              aria-label={`加入队列：${t.clip.title || '（未识别）'}`}
              onclick={() => addToQueue(i)}
            >
              <span class="w-7 shrink-0 text-2xs tabular-nums opacity-50">{i + 1}</span>
              <span class="truncate">{t.clip.title || '（未识别）'}</span>
              <span class="ml-auto shrink-0 text-2xs tabular-nums opacity-50">
                {fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}
              </span>
              {#if addedIdx === i}
                <Check class="h-3 w-3 shrink-0 text-accent" />
              {:else}
                <Plus class="h-3 w-3 shrink-0 opacity-40 transition group-hover:text-accent group-hover:opacity-100" />
              {/if}
            </button>
          </li>
        {/each}
        {#if previewRest > 0}
          <li class="px-1 py-0.5 text-2xs opacity-50">…其余 {previewRest} 首</li>
        {/if}
      </ol>
    {:else}
      <p class="mt-2 px-1 text-2xs opacity-50">范围内没有切片</p>
    {/if}
  </div>
</div>
