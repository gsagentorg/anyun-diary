<script lang="ts">
  import type { Recording, Block } from './types';
  import { blocksOf, fmtOffset, fmtClock, fmtDay, fmtDur, SOURCE_LABEL } from './types';
  import { Sparkles, Scissors, MoonStar } from 'lucide-svelte';

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
        ? `<b>${c.title}</b><br>${fmtClock(rec.start)} 开播 · ${abs(b.start)}<br>${fmtDur(b.end - b.start)} · ${SOURCE_LABEL[c.source] ?? c.source}`
        : b.kind === 'manual'
          ? `手工切片（未识别出歌，可能不准确）<br>${abs(b.start)}–${abs(b.end)} · ${fmtDur(b.end - b.start)}`
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
      <div class="mb-2 flex items-center gap-3">
        <div class="w-40 shrink-0 text-right">
          <div class="text-xs font-medium">{fmtDay(rec.start)}</div>
          <div class="text-[10px] opacity-60">{fmtClock(rec.start)} · {fmtDur(dur)}</div>
        </div>
        <div class="relative h-8 flex-1 rounded bg-base-300/40">
          <!-- zzz = 整行底纹（默认态） -->
          <!-- 刻度 -->
          {#each Array(nticks) as _, i}
            {@const t = i * TICK}
            <div class="absolute top-0 h-full w-px bg-base-content/10"
              style:left={(t / dur) * 100 + '%'}></div>
            <span class="absolute -top-0.5 -translate-x-1/2 text-[9px] opacity-40"
              style:left={(t / dur) * 100 + '%'}>{fmtOffset(t)}</span>
          {/each}
          <!-- 歌 + 手工切片块 -->
          {#each blocks as b (b.kind + b.start)}
            {#if b.kind !== 'zzz'}
              <div
                class="absolute top-1.5 h-5 rounded-sm transition-transform hover:scale-y-110"
                class:bg-accent={b.kind === 'song'}
                class:bg-warning={b.kind === 'manual'}
                style:left={(b.start / dur) * 100 + '%'};
                style:width={((b.end - b.start) / dur) * 100 + '%'}
                role="button" tabindex="0"
                onmousemove={(e) => showTip(e, b, rec)}
                onmouseleave={() => (tip = null)}
                onfocus={(e) => showTip(e as unknown as MouseEvent, b, rec)}
                onblur={() => (tip = null)}
              ></div>
            {/if}
          {/each}
        </div>
        <div class="w-24 shrink-0 text-[10px] opacity-70">
          {rec.clips.length} 歌 / {rec.segments.length} 段
        </div>
      </div>
    {/each}

    <!-- 图例 -->
    <div class="mt-6 flex flex-wrap gap-4 pl-40 text-xs">
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span><Sparkles class="h-3 w-3" /> 歌 · AI识曲（可能不准确）</span>
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-warning"></span><Scissors class="h-3 w-3" /> 手工切片（可能不准确）</span>
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-base-300/60"></span><MoonStar class="h-3 w-3" /> zzz · 没开播 / 233 在睡觉 awa</span>
    </div>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
