<script lang="ts">
  import type { Recording } from './types';
  import { fmtDay, fmtDur, fmtOffset, hueOf } from './types';
  import { player, playClip, adopt, buildRecTracks } from './player.svelte';
  import { ListMusic } from 'lucide-svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  // ffprobe 时长缺失（残缺录制）时，用切片/llc 段的最大末端估算，避免“有歌却无数据”
  function recDur(rec: Recording): number | null {
    if (rec.duration) return rec.duration;
    const ends = [
      ...(rec.clips ?? []).map((c) => c.offsetEnd),
      ...(rec.segments ?? []).map((s) => s.end),
    ];
    return ends.length ? Math.max(...ends) : null;
  }

  let open = $state<string | null>(null);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  {#each recordings as rec (rec.file)}
    {@const dur = recDur(rec)}
    {@const songs = rec.clips ?? []}
    <button
      class="card rounded-xl border bg-base-100 p-4 text-left transition hover:border-accent"
      class:border-accent={open === rec.file}
      onclick={() => (open = open === rec.file ? null : rec.file)}
    >
      <div class="flex items-baseline justify-between">
        <div class="font-semibold">{fmtDay(rec.start)}</div>
        <div class="flex items-center gap-2">
          <span
            class="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-accent transition hover:bg-accent/20"
            title="把这天的歌加入播放列表" onclick={(e) => { e.stopPropagation(); adopt(buildRecTracks(rec), 0); }}
          >
            <ListMusic class="h-3 w-3" /> 列表 </span
          >
          <div class="text-[10px] opacity-60">{dur ? fmtDur(dur) : '无数据'}{rec.duration ? '' : '（估算）'}</div>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span class="rounded-full bg-accent/15 px-2 py-0.5">🎵 {songs.length} 歌</span>
        <span class="rounded-full bg-base-300/50 px-2 py-0.5">共 {dur ? fmtDur(dur) : '无数据'}{rec.duration ? '' : '（估算）'}</span>
      </div>

      {#if open === rec.file}
        <ol class="mt-3 space-y-1.5 border-t pt-3">
          {#each songs as c, i (c.file)}
            {@const hue = hueOf(c.title)}
            {@const active = player.track?.clip.file === c.file}
            <li>
              <button
                class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition hover:bg-base-200"
                class:bg-accent={active}
                class:text-accent-content={active}
                onclick={() => playClip(rec, i)}
              >
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hue} 70% 60%)"></span>
                <span class="w-12 shrink-0 text-[10px] opacity-60">{fmtOffset(c.offsetStart)}</span>
                <span class="font-medium">{i + 1}. {c.title || '（未识别）'}</span>
                <span class="text-[10px] opacity-50">{fmtDur(c.offsetEnd - c.offsetStart)}</span>
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
