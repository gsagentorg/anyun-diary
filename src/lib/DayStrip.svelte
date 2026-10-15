<script lang="ts">
  import type { Recording } from './types';
  import { blocksOf, fmtDay, fmtDur, fmtOffset, hueOf } from './types';
  import { player, playClip } from './player.svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  let open = $state<string | null>(null);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  {#each recordings as rec (rec.file)}
    {@const blocks = blocksOf(rec)}
    {@const songs = blocks.filter((b) => b.kind === 'song')}
    {@const zzz = blocks.filter((b) => b.kind === 'zzz')}
    <button
      class="card rounded-xl border bg-base-100 p-4 text-left transition hover:border-accent"
      class:border-accent={open === rec.file}
      onclick={() => (open = open === rec.file ? null : rec.file)}
    >
      <div class="flex items-baseline justify-between">
        <div class="font-semibold">{fmtDay(rec.start)}</div>
        <div class="text-[10px] opacity-60">{rec.duration ? fmtDur(rec.duration) : '无数据'}</div>
      </div>
      <div class="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span class="rounded-full bg-accent/15 px-2 py-0.5">🎵 {songs.length} 歌</span>
        <span class="rounded-full bg-base-300/50 px-2 py-0.5">🌙 zzz {fmtDur(zzz.reduce((a, b) => a + b.end - b.start, 0))}</span>
        <span class="rounded-full bg-base-300/50 px-2 py-0.5">共 {rec.duration ? fmtDur(rec.duration) : '无数据'}</span>
      </div>

      {#if open === rec.file}
        <ol class="mt-3 space-y-1.5 border-t pt-3">
          {#each songs as b, i (i)}
            {@const hue = hueOf(b.clip?.title ?? '')}
            {@const clipIdx = (rec.clips ?? []).findIndex((c) => c.file === b.clip!.file)}
            {@const active = player.track?.clip.file === b.clip!.file}
            <li>
              <button
                class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition hover:bg-base-200"
                class:bg-accent={active}
                class:text-accent-content={active}
                onclick={() => { if (clipIdx >= 0) playClip(rec, clipIdx); }}
              >
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hue} 70% 60%)"></span>
                <span class="w-12 shrink-0 text-[10px] opacity-60">{fmtOffset(b.start)}</span>
                <span class="font-medium">{i + 1}. {b.clip?.title || '（未识别）'}</span>
                <span class="text-[10px] opacity-50">{fmtDur(b.end - b.start)}</span>
              </button>
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
