<script lang="ts">
  import type { Recording } from './types';
  import { shDayStart } from './playlist-core';
  import { fmtDur } from './types';
  import { adopt, buildRecTracks } from './player.svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  interface Cell {
    day: number;       // 当天 0 点 epoch
    hour: number;      // 0-23
    seconds: number;   // 该小时唱歌总秒数
    count: number;     // 歌数
    dayRecs: Recording[];
  }

  const md = (epoch: number) =>
    new Date(epoch * 1000).toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    });

  // 聚合：天 × 小时 → 唱歌秒数（切片跨小时时按占比拆分）
  const { days, cells, maxSeconds } = $derived.by(() => {
    const cellMap = new Map<string, Cell>();
    const daySet = new Map<number, Recording[]>();
    for (const rec of recordings) {
      const day = shDayStart(rec.start);
      const arr = daySet.get(day) ?? [];
      arr.push(rec);
      daySet.set(day, arr);
      for (const c of rec.clips ?? []) {
        let s = rec.start + c.offsetStart;
        const end = rec.start + c.offsetEnd;
        while (s < end) {
          const day = shDayStart(s);
          const hour = Math.min(23, Math.max(0, Math.floor((s - day) / 3600)));
          const hourEnd = day + (hour + 1) * 3600;
          const seg = Math.min(end, hourEnd) - s;
          const key = day + '|' + hour;
          const cell = cellMap.get(key) ?? { day, hour, seconds: 0, count: 0, dayRecs: [] };
          cell.seconds += seg;
          cell.count += 1;
          cellMap.set(key, cell);
          s = hourEnd;
        }
      }
    }
    const days = [...daySet.keys()].sort((a, b) => a - b);
    const cells = [...cellMap.values()];
    for (const c of cells) c.dayRecs = daySet.get(c.day) ?? [];
    const maxSeconds = Math.max(1, ...cells.map((c) => c.seconds));
    return { days, cells, maxSeconds };
  });

  const cellAt = (day: number, hour: number) => cells.find((c) => c.day === day && c.hour === hour);

  let tip = $state<{ x: number; y: number; html: string } | null>(null);
  function show(e: MouseEvent, c: Cell) {
    tip = {
      x: e.clientX, y: e.clientY,
      html: `<b>${md(c.day)} ${String(c.hour).padStart(2, '0')}:00–${String(c.hour + 1).padStart(2, '0')}:00</b><br>${c.count} 首 · 唱了 ${fmtDur(c.seconds)}`,
    };
  }

  function bg(c: Cell | undefined): string {
    if (!c || c.seconds <= 0) return 'hsl(0 0% 50% / 0.12)';
    const r = Math.min(1, c.seconds / maxSeconds);
    return `hsl(258 80% 60% / ${0.15 + 0.8 * r})`;
  }

  function playDay(c: Cell) {
    const tracks = c.dayRecs
      .flatMap((r) => buildRecTracks(r))
      .sort((a, b) => a.rec.start + a.clip.offsetStart - (b.rec.start + b.clip.offsetStart));
    if (tracks.length) adopt(tracks, 0);
  }
</script>

<div class="overflow-x-auto">
  <div class="min-w-[860px]">
    <div class="flex">
      <!-- 纵轴：0-23 时 -->
      <div class="w-10 shrink-0 pt-6">
        {#each Array(24) as _, h}
          {#if h % 3 === 0}
            <div class="text-right text-[9px] leading-[14px] opacity-40">{String(h).padStart(2, '0')}</div>
          {:else}
            <div class="leading-[14px]"></div>
          {/if}
        {/each}
      </div>

      <!-- 主体：每天一列 -->
      <div class="flex flex-1 gap-[3px]">
        {#each days as day (day)}
          <div class="flex flex-1 flex-col gap-[2px]">
            {#each Array(24) as _, h}
              {@const c = cellAt(day, h)}
              <div
                class="h-[12px] rounded-[3px] transition-transform hover:scale-110"
                style:background={bg(c)}
                role={c ? 'button' : undefined}
                tabindex={c ? 0 : undefined}
                onclick={c ? () => playDay(c) : undefined}
                onkeydown={(e) => { if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playDay(c); } }}
                onmousemove={(e) => c && show(e, c)}
                onmouseleave={() => (tip = null)}
              ></div>
            {/each}
            <div class="mt-1 text-center text-[9px] tabular-nums opacity-50">{md(day).slice(3)}</div>
          </div>
        {/each}
      </div>
    </div>

    <div class="mt-4 flex items-center gap-2 pl-10 text-xs">
      <span class="opacity-60">少</span>
      {#each [0.12, 0.3, 0.5, 0.7, 0.95] as o}
        <span class="h-3 w-3 rounded-[3px]" style:background={`hsl(258 80% 60% / ${o})`}></span>
      {/each}
      <span class="opacity-60">多（颜色 = 该小时唱歌时长；点击格子装载当天播放列表）</span>
    </div>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
