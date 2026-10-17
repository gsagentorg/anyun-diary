<script lang="ts">
  import type { Recording } from './types';
  import { blocksOf, fmtDay, fmtClock, fmtDur } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playClip, adopt, buildRecTracks } from './player.svelte';
  import { ListMusic } from 'lucide-svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  // 横向: 一天 24h; 纵向: 每个录像一行（按开播时间排序）
  const DAY = 86400;
  let tip = $state<{ x: number; y: number; html: string } | null>(null);

  function hourLabel(h: number) {
    return `${String(h).padStart(2, '0')}:00`;
  }
</script>

<div class="overflow-x-auto">
  <div class="min-w-[860px]">
    <div class="mb-1 flex pl-40">
      {#each Array(24) as _, h}
        <span class="flex-1 text-center text-[10px] opacity-50">{hourLabel(h)}</span>
      {/each}
    </div>

    {#each recordings as rec (rec.file)}
      {@const blocks = blocksOf(rec)}
      {@const dayStart = shDayStart(rec.start)}
      <div class="mb-2 flex items-center gap-3">
        <div class="w-40 shrink-0 text-right">
          <div class="text-xs font-medium">{fmtDay(rec.start)}</div>
          <div class="text-[10px] opacity-60">{fmtClock(rec.start)}</div>
          <button
            class="mt-0.5 flex items-center gap-1 text-[10px] text-accent transition hover:opacity-80"
            title="把这天的歌加入播放列表"
            onclick={() => adopt(buildRecTracks(rec), 0)}
          >
            <ListMusic class="h-3 w-3" /> 列表
          </button>
        </div>
        <div class="relative h-7 flex-1 rounded bg-base-200/50">
          {#each Array(24) as _, h}
            <div class="absolute top-0 h-full w-px bg-base-content/10"
              style:left={(h / 24) * 100 + '%'}></div>
          {/each}
          {#each blocks as b, bi (bi)}
            {#if b.kind === 'song' && b.clip}
              {@const clipIdx = (rec.clips ?? []).findIndex((c) => c.file === b.clip!.file)}
              {@const active = player.track?.clip.file === b.clip!.file}
              {@const x1 = Math.min(100, Math.max(0, ((rec.start + b.start - dayStart) / DAY) * 100))}
              {@const x2 = Math.min(100, Math.max(0, ((rec.start + b.end - dayStart) / DAY) * 100))}
              <div
                class="absolute top-1 h-5 rounded-sm bg-accent hover:scale-y-110 transition-transform"
                class:ring-2={active}
                class:ring-accent={active}
                style:left={x1 + '%'};
                style:width={Math.max(x2 - x1, 0.3) + '%'}
                role="button" tabindex="0"
                onclick={() => { if (clipIdx >= 0) playClip(rec, clipIdx); }}
                onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && clipIdx >= 0) { e.preventDefault(); playClip(rec, clipIdx); } }}
                onmousemove={(e) => {
                  const abs = (s: number) => new Date((rec.start + s) * 1000)
                    .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                  tip = { x: e.clientX, y: e.clientY, html: `<b>${b.clip?.title || '（未识别）'}</b><br>${abs(b.start)} · ${fmtDur(b.end - b.start)}` };
                }}
                onmouseleave={() => (tip = null)}
              ></div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}

    <div class="mt-4 flex gap-4 pl-40 text-xs">
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span> 歌（点击播放）</span>
    </div>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
