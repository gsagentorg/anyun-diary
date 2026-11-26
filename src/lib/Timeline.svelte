<script lang="ts">
  import {loadMonth,backend} from './backend.svelte';
  import {onDestroy} from 'svelte';
  import {createLatestOperation} from './interactions.js';
  import {createOfflineAvailability,offlineRowHint,resolveBrowseAudios} from './offline-availability';
  const availability=createOfflineAvailability();
  const playbackOperation=createLatestOperation();
  onDestroy(()=>playbackOperation.cancel());
  $effect(()=>{void backend.generation;void backend.base;playbackOperation.cancel();});
  $effect(()=>availability.setTargets(laneWidth>0?visibleLanes.flatMap(lane=>lane.audios.map(audio=>audioUrl(audio.opus))):[],backend.generation+':'+backend.base));
  import type { Audio } from './types';
  import { fmtDur, dateCard, hueOf, audioUrl } from './types';
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

  interface DetailRow { key: string; label: string; value: string }
  // 曲目详情：标题 + 按语义分行的字段（时间/时长/离线状态），不再用「·」串成一整行。
  // pinned = 触屏长按打开的常驻面板（点空白或 × 关闭）；非 pinned = 指针悬停的即时提示。
  let tip = $state<{ x: number; y: number; title: string; rows: DetailRow[]; pinned: boolean } | null>(null);
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

  const TIP_W = 260;
  const TIP_EDGE = 8;
  const LONG_PRESS_MS = 420;
  const PRESS_SLOP_PX = 8;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressPoint = { x: 0, y: 0 };
  let longPressFired = false;

  // 详情面板在窄屏（390px）里也不能出界：左缘夹在 [8, innerWidth-宽-8] 内。
  function tipLeft(x: number) {
    const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const w = Math.min(TIP_W, vw - TIP_EDGE * 2);
    return Math.max(TIP_EDGE, Math.min(x, vw - w - TIP_EDGE));
  }
  function tipTop(y: number) {
    const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
    return Math.max(TIP_EDGE, Math.min(y, vh - 132));
  }
  // 三态文案：cached 明说可离线播放；missing 用 offlineRowHint 的确认缺失文案；
  // unknown（或尚未查询）只说「未确认」，绝不暗示缺失。
  function songRows(b: SongBlock): DetailRow[] {
    const url = audioUrl(b.audio.opus);
    const hint = offlineRowHint($availability, url);
    const rows: DetailRow[] = [
      { key: 'time', label: '时间', value: clock(b.start) + '–' + clock(b.end) },
      { key: 'duration', label: '时长', value: fmtDur(b.end - b.start) },
    ];
    if (!$availability.online) {
      const state = $availability.statuses[url];
      rows.push({ key: 'offline', label: '离线', value: state === 'cached' ? '已完整缓存，可离线播放' : hint || '未确认缓存状态，可尝试播放' });
    }
    return rows;
  }
  function showSong(e: MouseEvent, b: SongBlock) {
    if (tip?.pinned) return; // 长按面板常驻时不跟随鼠标
    tip = { x: tipLeft(e.clientX + 12), y: tipTop(e.clientY + 12), title: b.audio.title || '（未识别）', rows: songRows(b), pinned: false };
  }
  function showBlank(e: MouseEvent, s: Seg) {
    if (tip?.pinned) return;
    tip = {
      x: tipLeft(e.clientX + 12), y: tipTop(e.clientY + 12), title: '空白时段', pinned: false,
      rows: [
        { key: 'duration', label: '时长', value: fmtDur(s.minutes * 60) },
        { key: 'compress', label: '压缩', value: '压至 1/' + Math.round(s.c ?? 1) },
      ],
    };
  }
  function endPress() {
    if (pressTimer !== undefined) { clearTimeout(pressTimer); pressTimer = undefined; }
  }
  // 触屏没有 hover：长按 ≥420ms 在卡片旁常驻显示同一份分组详情；
  // 短按/轻点仍是播放（不 preventDefault，也不改 click 语义），长按后的那次 click 被吞掉。
  function openDetails(b: SongBlock, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const below = r.bottom + 8;
    const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
    tip = { x: tipLeft(r.left), y: below > vh - 140 ? Math.max(TIP_EDGE, r.top - 140) : below, title: b.audio.title || '（未识别）', rows: songRows(b), pinned: true };
  }
  function onCardPointerDown(e: PointerEvent, b: SongBlock) {
    if (e.pointerType === 'mouse') return; // 鼠标走 hover
    endPress();
    longPressFired = false;
    pressPoint = { x: e.clientX, y: e.clientY };
    const el = e.currentTarget as HTMLElement;
    pressTimer = setTimeout(() => { pressTimer = undefined; longPressFired = true; openDetails(b, el); }, LONG_PRESS_MS);
  }
  function onCardPointerMove(e: PointerEvent) {
    if (pressTimer !== undefined && Math.hypot(e.clientX - pressPoint.x, e.clientY - pressPoint.y) > PRESS_SLOP_PX) endPress();
  }
  function onCardPointerEnd() { endPress(); }
  function onCardClick(b: SongBlock) {
    if (longPressFired) { longPressFired = false; return; } // 长按已展示详情，抬起不触发播放
    tip = null;
    void playSong(b);
  }
  // 常驻面板：点面板以外或按 Esc 关闭（面板内含关闭按钮）。
  $effect(() => {
    if (!tip?.pinned) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.('[data-track-details]')) tip = null;
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') tip = null; };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  });
  async function resolveAndPlay(songs:Audio[],replace=false) {
    const context=backend.generation+':'+backend.base;
    try {
      await playbackOperation.run((signal:AbortSignal)=>resolveBrowseAudios(songs,loadMonth,{signal,isCurrent:()=>context===backend.generation+':'+backend.base}),
        (full:Audio[])=>{if(replace)adopt(full.map(makeTrack),0);else if(full[0])playAudio(full[0]);});
    } catch(error) { if((error as Error)?.name!=='AbortError')throw error; }
  }
  function playSong(b:SongBlock){return resolveAndPlay([b.audio]);}
  function playDay(lane:typeof lanes[number]){return resolveAndPlay(lane.audios,true);}

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
              {@const stableUrl=audioUrl(b.audio.opus)}
              {@const offlineHint=offlineRowHint($availability,stableUrl)}
              <div
                class="absolute top-2.5 h-5 select-none rounded-sm transition hover:brightness-110"
                class:ring-2={active}
                class:ring-accent={active}
                class:offline-missing={!$availability.online&&$availability.statuses[stableUrl]==='missing'}
                data-offline-availability={$availability.online?undefined:($availability.statuses[stableUrl]??'unknown')}
                aria-label={(b.audio.title||'（未识别）')+'，时间 '+clock(b.start)+' 至 '+clock(b.end)+'，时长 '+fmtDur(b.end-b.start)+(offlineHint?'，'+offlineHint:'')}
                title={(b.audio.title||'（未识别）')+'\n时间 '+clock(b.start)+'–'+clock(b.end)+'\n时长 '+fmtDur(b.end-b.start)+(offlineHint?'\n离线 '+offlineHint:'')}
                style:left={x1 + '%'}; style:width={Math.max(x2 - x1, 0.15) + '%'}
                style:background="hsl({hue} var(--color-song-hue-sat) var(--color-song-hue-light))"
                role="button" tabindex="0"
                onclick={() => onCardClick(b)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
                onmousemove={(e) => showSong(e, b)}
                onmouseleave={() => { if (!tip?.pinned) tip = null; }}
                onpointerdown={(e) => onCardPointerDown(e, b)}
                onpointermove={onCardPointerMove}
                onpointerup={onCardPointerEnd}
                onpointercancel={onCardPointerEnd}
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
                {@const stableUrl=audioUrl(b.audio.opus)}
                {@const offlineHint=offlineRowHint($availability,stableUrl)}
                <div
                  class="absolute top-0 h-12 cursor-pointer select-none"
                  data-offline-availability={$availability.online?undefined:($availability.statuses[stableUrl]??'unknown')}
                  aria-label={(b.audio.title||'（未识别）')+'，时间 '+clock(b.start)+' 至 '+clock(b.end)+'，时长 '+fmtDur(b.end-b.start)+(offlineHint?'，'+offlineHint:'')}
                  title={(b.audio.title||'（未识别）')+'\n时间 '+clock(b.start)+'–'+clock(b.end)+'\n时长 '+fmtDur(b.end-b.start)+(offlineHint?'\n离线 '+offlineHint:'')}
                  style:left={visLeft - HIT_PAD + 'px'} style:width={visW + HIT_PAD * 2 + 'px'}
                  role="button" tabindex="0"
                  onclick={() => onCardClick(b)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playSong(b); } }}
                  onmousemove={(e) => showSong(e, b)}
                  onmouseleave={() => { if (!tip?.pinned) tip = null; }}
                  onpointerdown={(e) => onCardPointerDown(e, b)}
                  onpointermove={onCardPointerMove}
                  onpointerup={onCardPointerEnd}
                  onpointercancel={onCardPointerEnd}
                >
                  <div
                    class="absolute top-6 h-5 rounded-sm transition hover:brightness-110"
                    data-track-card
                    class:offline-missing={!$availability.online&&$availability.statuses[stableUrl]==='missing'}
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
  <div
    class="fixed z-50 rounded-lg border bg-base-100 p-2 text-xs shadow-lg"
    class:pointer-events-none={!tip.pinned}
    data-track-details
    data-details-source={tip.pinned ? 'touch' : 'pointer'}
    role={tip.pinned ? 'dialog' : 'tooltip'}
    aria-label="曲目详情"
    style:left={tip.x + 'px'} style:top={tip.y + 'px'}
    style:width={'min(' + TIP_W + 'px, calc(100vw - ' + TIP_EDGE * 2 + 'px))'}
  >
    <div class="flex items-start gap-2">
      <p class="min-w-0 flex-1 break-words font-medium" data-detail-key="title">{tip.title}</p>
      {#if tip.pinned}
        <button
          class="shrink-0 rounded px-1 text-2xs leading-4 opacity-60 transition hover:bg-base-200 hover:opacity-100"
          aria-label="关闭曲目详情"
          onclick={() => (tip = null)}>×</button>
      {/if}
    </div>
    <dl class="mt-1 space-y-0.5">
      {#each tip.rows as row (row.key)}
        <div class="flex gap-2">
          <dt class="w-8 shrink-0 opacity-60">{row.label}</dt>
          <dd class="min-w-0 flex-1 break-words" data-detail-key={row.key}>{row.value}</dd>
        </div>
      {/each}
    </dl>
  </div>
{/if}
<style>
  /* 确认缺失（离线下 status=missing）在减淡之外再加虚线描边：不靠悬停也能认出「不可离线播放」。
     未知状态不加描边，避免把「没查清」误报成「缺失」；cached 完全不改样式。
     outline 不参与布局，内缩 1px 画在色块内侧。 */
  .offline-missing { opacity: 0.55; outline: 1px dashed var(--color-warning); outline-offset: -1px; }
  /* 压缩模式卡片自身必须保持不透明：整层 opacity 会让下方时间压缩条透出（issue #10）。
     卡片的减淡改由覆盖层完成，色块仍是实心，压缩条在卡片下方不可见、卡片之外照常可见。 */
  [data-track-card].offline-missing { opacity: 1; }
  [data-track-card].offline-missing::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--color-base-100);
    opacity: 0.45;
    pointer-events: none;
  }
</style>
