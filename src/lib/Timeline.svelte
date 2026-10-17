<script lang="ts">
  import type { Recording, Clip } from './types';
  import { fmtDur, dateCard, hueOf } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playClip, adopt, buildRecTracks } from './player.svelte';
  import { ListMusic } from 'lucide-svelte';
  import HourAxis from './components/HourAxis.svelte';

  let { recordings }: { recordings: Recording[] } = $props();

  const DAY = 86400;
  let tip = $state<{ x: number; y: number; html: string } | null>(null);
  let laneWidth = $state(0);

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
      const dayStart = shDayStart(rec.start);
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
      out.push({
        dayStart,
        recs: lane.recs,
        songs: merged,
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

  const xPct = (abs: number, dayStart: number) =>
    Math.min(100, Math.max(0, ((abs - dayStart) / DAY) * 100));
</script>

<div class="overflow-x-auto">
  <div class="flex">
    <div class="w-24 shrink-0">
      <div class="mb-1 h-5"></div>
      {#each lanes as lane (lane.dayStart)}
        {@const dc = dateCard(lane.dayStart)}
        <div class="mb-2 flex h-10 flex-col justify-center">
          <div class="flex items-center gap-1">
            <span class="text-sm font-bold tabular-nums">{dc.md}</span>
            <span class="text-2xs opacity-60">{dc.wd}</span>
            {#if lane.recs.length > 1}
              <span class="rounded-full border px-1 text-2xs opacity-70">{lane.recs.length} 场</span>
            {/if}
          </div>
          <div class="flex items-center gap-1.5">
            <button
              class="flex items-center gap-0.5 text-2xs text-accent transition hover:opacity-80"
              title="把这天的歌加入播放列表"
              onclick={() => playDay(lane)}
            >
              <ListMusic class="h-3 w-3" /> 列表
            </button>
            <span class="truncate text-2xs tabular-nums opacity-60"
              >{lane.clipCount} 歌 · {fmtDur(lane.songDur)}</span
            >
          </div>
        </div>
      {/each}
    </div>

    <div class="min-w-0 flex-1" bind:clientWidth={laneWidth}>
      <div class="mb-1"><HourAxis width={laneWidth} /></div>

      {#each lanes as lane (lane.dayStart)}
        <div class="relative mb-2 h-10 rounded bg-base-300/40">
          {#each lane.songs as b, bi (bi)}
            {@const x1 = xPct(b.start, lane.dayStart)}
            {@const x2 = xPct(b.end, lane.dayStart)}
            {@const hue = hueOf(b.clip.title)}
            {@const active = player.track?.clip.file === b.clip.file}
            <div
              class="absolute top-2.5 h-5 rounded-sm transition hover:brightness-110"
              class:ring-2={active}
              class:ring-accent={active}
              style:left={x1 + '%'}; style:width={Math.max(x2 - x1, 0.15) + '%'}
              style:background="hsl({hue} 70% 60%)"
              role="button" tabindex="0"
              onclick={() => playSong(b)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
              onmousemove={(e) => showSong(e, b)}
              onmouseleave={() => (tip = null)}
            ></div>
          {/each}
        </div>
      {/each}
    </div>
  </div>

  <div class="mt-4 flex items-center gap-4 pl-24 text-xs">
    <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span> 歌（点击播放）</span>
  </div>
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
