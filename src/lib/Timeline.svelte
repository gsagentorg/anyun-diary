<script lang="ts">
  import {loadMonth} from './backend.svelte';
  import type { Audio } from './types';
  import { fmtDur, dateCard, hueOf } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playAudio, adopt, makeTrack } from './player.svelte.ts';
  import { buildLaneScale, lstarForRange, lstarToRgb, layoutSongs } from './lane-scale';
  import { theme } from './theme.svelte.ts';
  const grayL = (c: number) => theme.resolved === 'dark' ? lstarForRange(c, 1, 256, 72, 13) : lstarForRange(c, 1, 256);
  /** 三次贝塞尔缓动（等价 cubic-bezier(0.65,0,0.35,1)）：渐变 alpha 非线性推进 */
  const bez = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  /** 空白条背景：<14px 平涂；≥14px 贝塞尔缓动的边缘渐隐（中心最实、两侧透明），不再是扎眼的整条黑 */
  const blankBg = (c: number | null, w: number) => {
    const [r, g, b] = lstarToRgb(grayL(c ?? 1));
    if (w < 14) return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    const N = 10;
    const stops: string[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = bez(2 * Math.min(t, 1 - t));
      stops.push('rgba(' + r + ', ' + g + ', ' + b + ', ' + a.toFixed(3) + ') ' + (t * 100).toFixed(1) + '%');
    }
    return 'linear-gradient(to right, ' + stops.join(', ') + ')';
  };
  import type { LaneScale, Seg } from './lane-scale';
  import { ListMusic } from 'lucide-svelte';
  import HourAxis from './components/HourAxis.svelte';
  import StateHint from './components/StateHint.svelte';

  let {
    audios,
    laneMode = 'compress',
  }: { audios: Audio[]; laneMode?: 'linear' | 'compress' } = $props();

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
    audio: Audio;
  }
  interface DayLane {
    dayStart: number;
    audios: Audio[];
    songs: SongBlock[];
    clipCount: number;
    songDur: number;
  }

  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });

  // Audio 按上海自然日分泳道；月块视窗负责懒渲染，不截断当天歌曲。


  const lanes = $derived.by(() => {
    const map = new Map<number, Audio[]>();
    for (const audio of audios) {
      const dayStart = shDayStart(audio.startAt);
      const list = map.get(dayStart) ?? [];
      list.push(audio); map.set(dayStart, list);
    }
    const out = [...map.entries()].sort((a,b) => b[0]-a[0]).map(([dayStart, list]) => ({
      dayStart, audios: list,
      songs: list.sort((a,b)=>a.startAt-b.startAt).map(audio => ({start: audio.startAt, end: Math.min(dayStart+DAY,audio.startAt+Math.max(1,audio.duration ?? 1)), audio})),
      clipCount: list.length, songDur: list.reduce((sum,a)=>sum+(a.duration ?? 0),0),
    }));
    return out;
  });
  const visibleLanes = $derived(lanes);

  function showSong(e: MouseEvent, b: SongBlock) {
    const c = b.audio;
    tip = {
      x: e.clientX, y: e.clientY,
      html: `${c.title || '（未识别）'} · ${clock(b.start)}–${clock(b.end)} · ${fmtDur(b.end - b.start)}`,
    };
  }
  function showBlank(e: MouseEvent, s: Seg) {
    tip = {
      x: e.clientX, y: e.clientY,
      html: '空 ' + fmtDur(s.minutes * 60) + ' · 压至 1/' + Math.round(s.c ?? 1),
    };
  }
  async function playSong(b: SongBlock) {
    const full=await loadMonth(b.audio.monthId);playAudio(full.find(a=>a.id===b.audio.id)??b.audio);
  }
  async function playDay(lane: typeof lanes[number]) {
    const full=await loadMonth(lane.audios[0].monthId);adopt(lane.audios.map(audio=>makeTrack(full.find(a=>a.id===audio.id)??audio)), 0);
  }

  const xPct = (abs: number, dayStart: number) =>
    Math.min(100, Math.max(0, ((abs - dayStart) / DAY) * 100));

  // 浏览器查找只应命中可见文本：truncate 截断的歌名把 DOM 文本裁到可视容量（CJK≈10px/字，拉丁≈0.6），
  // 避免「搜得到却滚不到」（横向泳道容器内浏览器 find 无法滚动定位）
  function visibleTitle(title: string, w: number): string {
    const t = title || '（未识别）';
    const cap = Math.max(2, Math.floor((w - 10) / 10));
    if (t.length <= cap) return t;
    let budget = cap;
    let out = '';
    for (const ch of t) {
      const cost = /[\x00-\x7F]/.test(ch) ? 0.6 : 1;
      if (cost > budget) break;
      out += ch;
      budget -= cost;
    }
    return out;
  }

  // compress 模式：每簇（间隔 >= CLUSTER_GAP 分段）首歌起点一个 HH:MM 标签
  function laneLabels(
    songs: SongBlock[],
    scale: LaneScale,
    rects: { left: number; width: number }[],
  ): { x: number; text: string; key: number }[] {
    const out: { x: number; text: string; key: number }[] = [];
    let prevX = -Infinity;
    for (let i = 0; i < songs.length; i++) {
      if (i > 0 && songs[i].start - songs[i - 1].end < CLUSTER_GAP) continue;
      const rect = rects[i];
      if (!rect) continue;
      const x = rect.left;
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
      ? visibleLanes.map((lane) => ({
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
</script>

<div data-timeline-container class="overflow-x-auto">
  {#if lanes.length === 0}
    <StateHint kind="empty" />
  {:else}
  <div class="flex">
    <div class="w-24 shrink-0">
      {#if laneMode === 'linear'}<div class="mb-1 h-5"></div>{/if}
      {#each visibleLanes as lane (lane.dayStart)}
        {@const dc = dateCard(lane.dayStart)}
        <div class="mb-2 flex flex-col justify-center {laneMode === 'linear' ? 'h-10' : 'h-12'}">
          <div class="flex items-center gap-1">
            <span class="text-sm font-bold tabular-nums">{dc.md}</span>
            <span class="text-2xs opacity-60">{dc.wd}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              class="flex items-center gap-0.5 text-2xs text-accent transition hover:opacity-80"
              title="用这一天的歌替换播放列表"
              onclick={() => playDay(lane)}
            >
              <ListMusic class="h-3 w-3" /> 替换列表
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
              {@const hue = hueOf(b.audio.title)}
              {@const active = player.track?.audio.id === b.audio.id}
              <div
                class="absolute top-2.5 h-5 rounded-sm transition hover:brightness-110"
                class:ring-2={active}
                class:ring-accent={active}
                style:left={x1 + '%'}; style:width={Math.max(x2 - x1, 0.15) + '%'}
                style:background="hsl({hue} var(--color-song-hue-sat) var(--color-song-hue-light))"
                role="button" tabindex="0"
                onclick={() => playSong(b)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
                onmousemove={(e) => showSong(e, b)}
                onmouseleave={() => (tip = null)}
              ></div>
            {/each}
          </div>
        {:else if laneWidth > 0}
          {@const rects = scale
            ? layoutSongs(
                lane.songs.map((b) => ({ x0: scale.xAt(b.start), x1: scale.xAt(b.end) })),
                BLOCK_MIN_W,
                BLOCK_GAP,
              )
            : []}
          {@const labels = scale ? laneLabels(lane.songs, scale, rects) : []}
          <div class="relative mb-2 h-12">
            {#if scale}
              {#each scale.segs as s (s.t0)}
                {#if s.kind === 'blank' && s.x1 - s.x0 >= 2}
                  {@const sw = s.x1 - s.x0}
                  <div
                    class="absolute top-[34px] h-2.5 -translate-y-1/2 rounded-sm"
                    style:left={s.x0 + 'px'} style:width={sw + 'px'}
                    style:background={blankBg(s.c, sw)}
                    role="img"
                    aria-label="空白 {fmtDur(s.minutes * 60)}"
                    onmousemove={(e) => showBlank(e, s)}
                    onmouseleave={() => (tip = null)}
                  ></div>
                {/if}
              {/each}
              {#each labels as l (l.key)}
                <div class="absolute top-0.5 text-2xs whitespace-nowrap opacity-55" style:left={l.x + 'px'}>
                  {l.text}
                </div>
              {/each}
              {#each lane.songs as b, bi (bi)}
                {@const rect = rects[bi]}
                {@const visW = rect.width}
                {@const visLeft = rect.left}
                {@const hue = hueOf(b.audio.title)}
                {@const active = player.track?.audio.id === b.audio.id}
                <div
                  class="absolute top-0 h-12 cursor-pointer"
                  style:left={visLeft - HIT_PAD + 'px'} style:width={visW + HIT_PAD * 2 + 'px'}
                  role="button" tabindex="0"
                  onclick={() => playSong(b)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
                  onmousemove={(e) => showSong(e, b)}
                  onmouseleave={() => (tip = null)}
                >
                  <div
                    class="absolute top-6 h-5 rounded-sm transition hover:brightness-110"
                    class:ring-2={active}
                    class:ring-accent={active}
                    style:left={HIT_PAD + 'px'} style:width={visW + 'px'}
                    style:background="hsl({hue} var(--color-song-hue-sat) var(--color-song-hue-light))"
                  >
                    {#if visW >= 64}
                      <span
                        class="pointer-events-none block truncate px-1 text-2xs leading-5 text-white"
                        style:text-shadow="0 1px 2px rgb(0 0 0 / 0.45)"
                        >{visibleTitle(b.audio.title, visW)}</span
                      >
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="relative mb-2 h-12"></div>
        {/if}
      {/each}
    </div>
  </div>

  {/if}
</div>

{#if tip}
  <div class="pointer-events-none fixed z-50 max-w-xs rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    style:left={tip.x + 12 + 'px'} style:top={tip.y + 12 + 'px'}>
    {tip.html}
  </div>
{/if}