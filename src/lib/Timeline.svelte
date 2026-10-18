<script lang="ts">
  import type { Recording, Clip } from './types';
  import { fmtDur, dateCard, hueOf } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playClip, adopt, buildRecTracks } from './player.svelte';
  import { buildLaneScale, grayLStar, lstarForRange, lstarToRgb, layoutSongs } from './lane-scale';
  import type { LaneScale, Seg } from './lane-scale';
  import { ListMusic } from 'lucide-svelte';
  import HourAxis from './components/HourAxis.svelte';
  import StateHint from './components/StateHint.svelte';

  let {
    recordings,
    laneMode = 'compress',
  }: { recordings: Recording[]; laneMode?: 'linear' | 'compress' } = $props();

  const DAY = 86400;
  const CLUSTER_GAP = 600; // 与 lane-scale 默认 M 一致：>=10min 视为一簇间隔
  const LABEL_MIN_GAP = 48;
  const BLOCK_MIN_W = 12;
  const BLOCK_GAP = 1;
  const HIT_PAD = 6;

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
  function showBlank(e: MouseEvent, s: Seg) {
    tip = {
      x: e.clientX, y: e.clientY,
      html: '空 ' + fmtDur(s.minutes * 60) + ' · 压至 1/' + Math.round(s.c ?? 1),
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

  // compress 模式：每簇（间隔 >= CLUSTER_GAP 分段）首歌起点一个 HH:MM 标签
  function laneLabels(songs: SongBlock[], scale: LaneScale): { x: number; text: string; key: number }[] {
    const out: { x: number; text: string; key: number }[] = [];
    let prevX = -Infinity;
    for (let i = 0; i < songs.length; i++) {
      if (i > 0 && songs[i].start - songs[i - 1].end < CLUSTER_GAP) continue;
      const x = scale.xAt(songs[i].start);
      if (x > laneWidth) continue; // 超出泳道右缘
      if (x - prevX < LABEL_MIN_GAP) continue; // 与上一个标签过近
      out.push({ x, text: clock(songs[i].start), key: i });
      prevX = x;
    }
    return out;
  }

  // compress 模式：先建全部泳道 scale（单一对象，供灰度 Map 键 c 值），再做页面级灰度归一化
  const laneScales = $derived(
    laneWidth > 0
      ? lanes.map((lane) => ({
          lane,
          scale: buildLaneScale(
            lane.songs.map((s) => ({ start: s.start, end: s.end })),
            laneWidth,
            lane.dayStart,
            lane.dayStart + DAY,
          ),
        }))
      : [],
  );
  // 固定对数域 [1,256]：整体缩放不影响 c，图例无需动态计算（owner 10:13 定）
  const LGT_MAX = 256;
  const lgLight = lstarToRgb(lstarForRange(1, 1, LGT_MAX));
  const lgDark = lstarToRgb(lstarForRange(LGT_MAX, 1, LGT_MAX));
  const legendGray = {
    css:
      'linear-gradient(to right, rgb(' + lgLight[0] + ', ' + lgLight[1] + ', ' + lgLight[2] + '), rgb(' +
      lgDark[0] + ', ' + lgDark[1] + ', ' + lgDark[2] + '))',
  };
</script>

<div class="overflow-x-auto">
  {#if lanes.length === 0}
    <StateHint kind="empty" />
  {:else}
  <div class="flex">
    <div class="w-24 shrink-0">
      <div class="mb-1 h-5"></div>
      {#each lanes as lane (lane.dayStart)}
        {@const dc = dateCard(lane.dayStart)}
        <div class="mb-2 flex h-10 flex-col justify-center">
          <div class="flex items-center gap-1">
            <span class="text-sm font-bold tabular-nums">{dc.md}</span>
            <span class="text-2xs opacity-60">{dc.wd}</span>
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
      {#if laneMode === 'linear'}
        <div class="mb-1"><HourAxis width={laneWidth} /></div>
      {/if}

      {#each laneScales as { lane, scale } (lane.dayStart)}
        {#if laneMode === 'linear'}
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
        {:else if laneWidth > 0}
          {@const labels = scale ? laneLabels(lane.songs, scale) : []}
          {@const rects = scale
            ? layoutSongs(
                lane.songs.map((b) => ({ x0: scale.xAt(b.start), x1: scale.xAt(b.end) })),
                BLOCK_MIN_W,
                BLOCK_GAP,
              )
            : []}
          <div class="relative mb-2 h-10">
            {#if scale}
              {#each scale.segs as s (s.t0)}
                {#if s.kind === 'blank' && s.x1 - s.x0 >= 2}
                  {@const sw = s.x1 - s.x0}
                  {@const rgb = lstarToRgb(lstarForRange(s.c ?? 1, 1, 256))}
                  <div
                    class="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm"
                    style:left={s.x0 + 'px'} style:width={sw + 'px'}
                    style:background="rgb({rgb[0]}, {rgb[1]}, {rgb[2]})"
                    role="img"
                    aria-label="空白 {fmtDur(s.minutes * 60)}"
                    onmousemove={(e) => showBlank(e, s)}
                    onmouseleave={() => (tip = null)}
                  ></div>
                {/if}
              {/each}
              {#each labels as l (l.key)}
                <div class="absolute -top-3 text-2xs whitespace-nowrap opacity-55" style:left={l.x + 'px'}>
                  {l.text}
                </div>
              {/each}
              {#each lane.songs as b, bi (bi)}
                {@const rect = rects[bi]}
                {@const visW = rect.width}
                {@const visLeft = rect.left}
                {@const hue = hueOf(b.clip.title)}
                {@const active = player.track?.clip.file === b.clip.file}
                <div
                  class="absolute top-0 h-10 cursor-pointer"
                  style:left={visLeft - HIT_PAD + 'px'} style:width={visW + HIT_PAD * 2 + 'px'}
                  role="button" tabindex="0"
                  onclick={() => playSong(b)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
                  onmousemove={(e) => showSong(e, b)}
                  onmouseleave={() => (tip = null)}
                >
                  <div
                    class="absolute top-2.5 h-5 rounded-sm transition hover:brightness-110"
                    class:ring-2={active}
                    class:ring-accent={active}
                    style:left={HIT_PAD + 'px'} style:width={visW + 'px'}
                    style:background="hsl({hue} 70% 60%)"
                  ></div>
                </div>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="relative mb-2 h-10"></div>
        {/if}
      {/each}
    </div>
  </div>

  <div class="mt-4 flex items-center gap-4 pl-24 text-xs">
    <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span> 歌（点击播放）</span>
    {#if laneMode === 'compress'}
<span class="flex items-center gap-1">
          <span class="text-2xs opacity-60 tabular-nums">×1（同歌速）</span>
          <span class="h-3 w-16 rounded-sm" style="background:{legendGray.css}"></span>
          <span class="text-2xs opacity-60 tabular-nums">×256</span>
          空白压缩倍数（相对歌的线性刻度，越深压得越狠）
        </span>
    {/if}
  </div>
  {/if}
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {@html tip.html}
  </div>
{/if}
