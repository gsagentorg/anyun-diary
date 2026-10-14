<script lang="ts">
  import type { Recording, Block } from './types';
  import { blocksOf, fmtOffset, fmtClock, fmtDur, dateCard } from './types';
  import { player, playClip } from './player.svelte';
  import { Sparkles, MoonStar } from 'lucide-svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  const TICK = 1800; // 30min
  let tip = $state<{ x: number; y: number; html: string } | null>(null);

  function showTip(e: MouseEvent, b: Block, rec: Recording) {
    const abs = (s: number) =>
      new Date((rec.start + s) * 1000).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false
      });
    const c = b.clip;
    const body =
      b.kind === 'song' && c
        ? `<b>${c.title || '（未识别）'}</b><br>${fmtClock(rec.start)} 开播 · ${abs(b.start)}<br>${fmtDur(b.end - b.start)}`
        : `zzz · 没开播 / 在睡觉 awa<br>${abs(b.start)}–${abs(b.end)} · ${fmtDur(b.end - b.start)}`;
    tip = { x: e.clientX, y: e.clientY, html: body };
  }
</script>

<div class="overflow-x-auto">
  <div class="min-w-[860px]">
    {#each recordings as rec (rec.file)}
      {@const blocks = blocksOf(rec)}
      {@const dur = rec.duration ?? 0}
      {@const nticks = Math.ceil(dur / TICK) + 1}
      {@const dc = dateCard(rec.start)}
      <div class="mb-2 flex items-center gap-3">
        <div class="w-44 shrink-0">
          <div class="flex items-baseline gap-1.5">
            <span class="text-sm font-semibold tabular-nums">{dc.md}</span>
            <span class="text-xs opacity-70">{dc.wd}</span>
          </div>
          <div class="text-[10px] tabular-nums opacity-60">
            {dc.hm} 开播 · {dur > 0 ? fmtDur(dur) : '时长未知'}
          </div>
        </div>
        <div class="relative h-8 flex-1 rounded bg-base-300/40">
          {#if dur > 0}
            <!-- 刻度 -->
            {#each Array(nticks) as _, i}
              {@const t = i * TICK}
              <div class="absolute top-0 h-full w-px bg-base-content/10"
                style:left={(t / dur) * 100 + '%'}></div>
              <span class="absolute -top-0.5 -translate-x-1/2 text-[9px] opacity-40"
                style:left={(t / dur) * 100 + '%'}>{fmtOffset(t)}</span>
            {/each}
            <!-- 歌块（点击播放） -->
            {#each blocks as b, bi (bi)}
              {#if b.kind === 'song' && b.clip}
                {@const clipIdx = (rec.clips ?? []).findIndex((c) => c.file === b.clip!.file)}
                {@const active = player.track?.clip.file === b.clip!.file}
                <div
                  class="absolute top-1.5 h-5 rounded-sm bg-accent transition-transform hover:scale-y-110"
                  class:ring-2={active}
                  class:ring-accent={active}
                  style:left={(b.start / dur) * 100 + '%'};
                  style:width={((b.end - b.start) / dur) * 100 + '%'}
                  role="button" tabindex="0"
                  onclick={() => { if (clipIdx >= 0) playClip(rec, clipIdx); }}
                  onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && clipIdx >= 0) { e.preventDefault(); playClip(rec, clipIdx); } }}
                  onmousemove={(e) => showTip(e, b, rec)}
                  onmouseleave={() => (tip = null)}
                  onfocus={(e) => showTip(e as unknown as MouseEvent, b, rec)}
                  onblur={() => (tip = null)}
                ></div>
              {/if}
            {/each}
          {:else}
            <span class="absolute inset-0 flex items-center justify-center text-[10px] opacity-50">时长未知</span>
          {/if}
        </div>
        <div class="w-20 shrink-0 text-[10px] opacity-70">
          {rec.clips?.length ?? 0} 歌
        </div>
      </div>
    {/each}

    <!-- 图例 -->
    <div class="mt-6 flex flex-wrap gap-4 pl-40 text-xs">
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span><Sparkles class="h-3 w-3" /> 歌（点击播放）</span>
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-base-300/60"></span><MoonStar class="h-3 w-3" /> zzz · 没开播 / 在睡觉 awa</span>
    </div>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
