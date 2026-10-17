<script lang="ts">
  import type { Recording, Clip } from './types';
  import { fmtDur, dateCard } from './types';
  import { player, playClip, adopt, buildRecTracks } from './player.svelte';
  import { ListMusic, MoonStar } from 'lucide-svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  const DAY = 86400;
  let tip = $state<{ x: number; y: number; html: string } | null>(null);

  interface SongBlock {
    start: number; // 绝对 epoch
    end: number;
    rec: Recording;
    clip: Clip;
  }
  interface DayLane {
    dayStart: number;
    recs: Recording[];
    songs: SongBlock[];
    zzz: { start: number; end: number }[];
    clipCount: number;
    songDur: number;
  }

  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });

  // 按天合并：同一天的所有录像画进同一条泳道
  const lanes = $derived.by(() => {
    const map = new Map<number, { recs: Recording[]; songs: SongBlock[] }>();
    for (const rec of recordings) {
      const dayStart = Math.floor(rec.start / DAY) * DAY;
      let lane = map.get(dayStart);
      if (!lane) { lane = { recs: [], songs: [] }; map.set(dayStart, lane); }
      lane.recs.push(rec);
      for (const c of rec.clips ?? []) {
        lane.songs.push({ start: rec.start + c.offsetStart, end: rec.start + c.offsetEnd, rec, clip: c });
      }
    }
    const out = [];
    for (const [dayStart, lane] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      lane.songs.sort((a, b) => a.start - b.start);
      // 重叠的歌块合并
      const merged: SongBlock[] = [];
      for (const s of lane.songs) {
        const last = merged[merged.length - 1];
        if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
        else merged.push({ ...s });
      }
      // 相邻歌块之间的空隙 = zzz
      const zzz: { start: number; end: number }[] = [];
      for (let i = 1; i < merged.length; i++) {
        const gap = merged[i].start - merged[i - 1].end;
        if (gap > 60) zzz.push({ start: merged[i - 1].end, end: merged[i].start });
      }
      out.push({
        dayStart,
        recs: lane.recs,
        songs: merged,
        zzz,
        clipCount: lane.recs.reduce((a, r) => a + (r.clips?.length ?? 0), 0),
        songDur: lane.songs.reduce((a, s) => a + s.end - s.start, 0),
      });
    }
    return out;
  });

  function showSong(e: MouseEvent, b: SongBlock) {
    const c = b.clip;
    tip = {
      x: e.clientX, y: e.clientY,
      html: `<b>${c.title || '（未识别）'}</b><br>${clock(b.start)}–${clock(b.end)}<br>${fmtDur(b.end - b.start)} · ${b.rec.file}`,
    };
  }
  function showZzz(e: MouseEvent, z: { start: number; end: number }) {
    tip = {
      x: e.clientX, y: e.clientY,
      html: `zzz<br>${clock(z.start)}–${clock(z.end)} · ${fmtDur(z.end - z.start)}`,
    };
  }

  function playSong(b: SongBlock) {
    const idx = (b.rec.clips ?? []).findIndex((c) => c.file === b.clip.file);
    if (idx >= 0) playClip(b.rec, idx);
  }
  function playDay(lane: typeof lanes[number]) {
    const tracks = lane.recs
      .flatMap((r) => buildRecTracks(r))
      .sort((a, b) => a.rec.start + a.clip.offsetStart - (b.rec.start + b.clip.offsetStart));
    adopt(tracks, 0);
  }

  const nticks = 48; // 每 30min 一格
  const xPct = (abs: number, dayStart: number) =>
    Math.min(100, Math.max(0, ((abs - dayStart) / DAY) * 100));
</script>

<div class="overflow-x-auto">
  <div class="min-w-[860px]">
    <div class="mb-1 flex pl-48">
      {#each Array(25) as _, h}
        {#if h % 2 === 0}
          <span class="text-center text-[10px] opacity-40" style:width={2 / 25 * 100 + '%'}>{String(h).padStart(2, '0')}:00</span>
        {/if}
      {/each}
    </div>

    {#each lanes as lane (lane.dayStart)}
      {@const dc = dateCard(lane.dayStart)}
      <div class="mb-2 flex items-center gap-3">
        <div class="w-44 shrink-0">
          <div class="flex items-baseline gap-1.5">
            <span class="text-sm font-semibold tabular-nums">{dc.md}</span>
            <span class="text-xs opacity-70">{dc.wd}</span>
            {#if lane.recs.length > 1}<span class="text-[10px] opacity-50">{lane.recs.length} 场</span>{/if}
          </div>
          <div class="text-[10px] tabular-nums opacity-60">
            {lane.clipCount} 歌 · 总 {fmtDur(lane.songDur)}
          </div>
          <button
            class="mt-0.5 flex items-center gap-1 text-[10px] text-accent transition hover:opacity-80"
            title="把这天的歌加入播放列表"
            onclick={() => playDay(lane)}
          >
            <ListMusic class="h-3 w-3" /> 列表
          </button>
        </div>

        <div class="relative h-8 flex-1 rounded bg-base-300/40">
          {#each Array(nticks) as _, i}
            <div class="absolute top-0 h-full w-px bg-base-content/10" style:left={(i / nticks) * 100 + '%'}></div>
          {/each}

          {#each lane.zzz as z, zi (zi)}
            {@const x1 = xPct(z.start, lane.dayStart)}
            {@const x2 = xPct(z.end, lane.dayStart)}
            {@const w = Math.max(x2 - x1, 0.15)}
            {#if w > 0.05}
              <div
                class="absolute top-1.5 h-5 rounded-sm bg-base-300/60"
                style:left={x1 + '%'}; style:width={w + '%'}
                onmousemove={(e) => showZzz(e, z)}
                onmouseleave={() => (tip = null)}
              ></div>
            {/if}
          {/each}

          {#each lane.songs as b, bi (bi)}
            {@const x1 = xPct(b.start, lane.dayStart)}
            {@const x2 = xPct(b.end, lane.dayStart)}
            {@const active = player.track?.clip.file === b.clip.file}
            <div
              class="absolute top-1.5 h-5 rounded-sm bg-accent transition-transform hover:scale-y-110"
              class:ring-2={active}
              class:ring-accent={active}
              style:left={x1 + '%'}; style:width={Math.max(x2 - x1, 0.15) + '%'}
              role="button" tabindex="0"
              onclick={() => playSong(b)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
              onmousemove={(e) => showSong(e, b)}
              onmouseleave={() => (tip = null)}
            ></div>
          {/each}
        </div>
      </div>
    {/each}

    <div class="mt-4 flex items-center gap-4 pl-48 text-xs">
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span> 歌（点击播放）</span>
      <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-base-300/60"></span><MoonStar class="h-3 w-3" /> zzz</span>
    </div>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
