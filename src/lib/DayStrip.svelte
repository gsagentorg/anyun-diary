<script lang="ts">
  import type { Recording } from './types';
  import { blocksOf, fmtDay, fmtClock, fmtDur, fmtOffset, hueOf, SOURCE_LABEL } from './types';
  import { Music, Scissors, MoonStar } from 'lucide-svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  let open = $state<string | null>(null);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  {#each recordings as rec (rec.file)}
    {@const blocks = blocksOf(rec)}
    {@const songs = blocks.filter((b) => b.kind === 'song')}
    {@const manual = blocks.filter((b) => b.kind === 'manual')}
    {@const zzz = blocks.filter((b) => b.kind === 'zzz')}
    <button
      class="card rounded-xl border bg-base-100 p-4 text-left transition hover:border-accent"
      class:border-accent={open === rec.file}
      onclick={() => (open = open === rec.file ? null : rec.file)}
    >
      <div class="flex items-baseline justify-between">
        <div class="font-semibold">{fmtDay(rec.start)}</div>
        <div class="text-[10px] opacity-60">{fmtClock(rec.start)} 开播</div>
      </div>
      <div class="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span class="rounded-full bg-accent/15 px-2 py-0.5">🎵 {songs.length} 歌</span>
        <span class="rounded-full bg-warning px-2 py-0.5">✂️ {manual.length} 手工</span>
        <span class="rounded-full bg-base-300/50 px-2 py-0.5">🌙 zzz {fmtDur(zzz.reduce((a, b) => a + b.end - b.start, 0))}</span>
        <span class="rounded-full bg-base-300/50 px-2 py-0.5">共 {fmtDur(rec.duration ?? 0)}</span>
      </div>

      {#if open === rec.file}
        <ol class="mt-3 space-y-1.5 border-t pt-3">
          {#each songs as b, i (b.start)}
            {@const hue = hueOf(b.clip?.title ?? '')}
            <li class="flex items-center gap-2 text-xs">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hue} 70% 60%)"></span>
              <span class="w-12 shrink-0 text-[10px] opacity-60">{fmtOffset(b.start)}</span>
              <span class="font-medium">{i + 1}. {b.clip?.title}</span>
              <span class="text-[10px] opacity-50">{fmtDur(b.end - b.start)} · {SOURCE_LABEL[b.clip?.source ?? ''] ?? b.clip?.source}</span>
            </li>
          {/each}
          {#if songs.length === 0}
            <li class="text-xs opacity-50">这一天没有已识别的歌</li>
          {/if}
        </ol>
      {/if}
    </button>
  {/each}
</div>
