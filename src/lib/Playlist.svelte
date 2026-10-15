<script lang="ts">
  import type { Recording } from './types';
  import { player, adopt } from './player.svelte';
  import { tracksInRange, dayStartOf, validRange, buildM3u } from './playlist.svelte';
  import { fmtDur, fmtOffset, fmtDay, hueOf } from './types';
  import { Play, Download, ListMusic, Search, X } from 'lucide-svelte';

  let { recordings, open = $bindable(false) }: { recordings: Recording[]; open?: boolean } = $props();

  let from = $state('');
  let to = $state('');
  let error = $state('');

  const list = $derived(player.playlist);
  const total = $derived.by(() =>
    list.reduce((a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart), 0),
  );

  function label(): string {
    if (!from && !to) return '全部';
    if (!validRange(from, to)) return '（无效范围）';
    const a = fmtDay(dayStartOf(from)!);
    const b = (dayStartOf(to)! + 86400 - 1) * 1000;
    return a === fmtDay(b / 1000) ? a : `${from} → ${to}`;
  }

  function collect(): { tracks: ReturnType<typeof tracksInRange>; ok: boolean } {
    const lo = from ? dayStartOf(from) : null;
    const hi = to ? dayStartOf(to)! + 86400 : null;
    if (from && to && !validRange(from, to)) return { tracks: [], ok: false };
    const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
    return { tracks, ok: tracks.length > 0 };
  }

  function playInternal() {
    const { tracks, ok } = collect();
    if (!ok) {
      error = '范围内没有切片';
      return;
    }
    error = '';
    adopt(tracks, 0);
  }

  function playExternal() {
    const { tracks, ok } = collect();
    if (!ok) {
      error = '范围内没有切片';
      return;
    }
    error = '';
    const text = buildM3u(tracks, location.origin, `安允日记 ${label()}`);
    const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `anyun-diary-playlist-${from || 'all'}-${to || 'all'}.m3u`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<div class="card rounded-xl border bg-base-100 p-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2 text-sm font-semibold">
      <ListMusic class="h-4 w-4" />
      动态播放列表
      {#if list.length > 0}
        <span class="rounded-full bg-accent/15 px-2 text-[10px] tabular-nums opacity-80">
          {list.length} 首 · {fmtDur(total)}
        </span>
      {/if}
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
      onclick={playInternal}
    >
      <Search class="h-3 w-3" /> 应用并播放
    </button>
    <button
      class="flex items-center gap-1 rounded border border-base-300 px-2.5 py-1 transition hover:bg-base-200"
      onclick={playExternal}
      title="生成 m3u 文件，用外部播放器（VLC/mpv/飞傲…）打开"
    >
      <Download class="h-3 w-3" /> 外部播放器（.m3u）
    </button>
    {#if error}
      <span class="text-warning">{error}</span>
    {/if}
  </div>

  {#if list.length > 0}
    <ol class="mt-3 max-h-72 space-y-1 overflow-y-auto border-t pt-3 text-xs">
      {#each list as t, i (t.clip.file)}
        {@const hue = hueOf(t.clip.title)}
        <li>
          <button
            class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition hover:bg-base-200 {i === player.pos ? 'bg-accent/15' : ''}"
            onclick={() => {
              player.pos = i;
              adopt(list, i);
            }}
          >
            {#if i === player.pos}
              <Play class="h-3 w-3 shrink-0 text-accent" />
            {:else}
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hue} 70% 60%)"></span>
            {/if}
            <span class="w-14 shrink-0 text-[10px] opacity-50">{fmtDay(t.rec.start).slice(5, 11)}</span>
            <span class="w-10 shrink-0 text-[10px] opacity-50">{fmtOffset(t.clip.offsetStart)}</span>
            <span class="truncate font-medium">{t.clip.title || '（未识别）'}</span>
            <span class="shrink-0 text-[10px] opacity-50">{fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</div>
