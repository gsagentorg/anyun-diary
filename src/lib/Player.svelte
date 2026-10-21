<script lang="ts">
  import { onMount } from 'svelte';
  import { player, step, getAudio, sleep, startSleep, cancelSleep, onTrackEnded, toggleShuffle, reportPlaybackState, setRate, initRate } from './player.svelte';
  import { fmtClockShort, dateCard } from './types';
  import { Pause, Play, SkipBack, SkipForward, X, MoonStar, Shuffle, ListMusic, Gauge, MoreVertical } from 'lucide-svelte';

  let progress = $state(0);
  let duration = $state(0);
  let sleepOpen = $state(false);
  let rateOpen = $state(false);
  let menuOpen = $state(false);

  // 功能钮空间自适应折叠：0=全平铺，1=折倍速，2=再折随机，3=折睡眠（全部进 ⋮）
  let foldCount = $state(0);
  // 两行退路：全折后仍放不下（约 <480px）→ 右区独占一行（order-last basis-full justify-around）
  let stacked = $state(typeof document === 'undefined' ? false : document.documentElement.clientWidth < 480);
  let widths = $state<{ rate?: number; shuffle?: number; sleep?: number }>({});
  const FOLD_ORDER = ['rate', 'shuffle', 'sleep'] as const;
  type FoldKey = (typeof FOLD_ORDER)[number];
  const TITLE_MIN = 110; // 左区标题块 min-width（与模板 min-w-[110px] 同步）
  const PROGRESS_MIN = 80; // 中区进度条 min-width（与模板 min-w-[80px] 同步）
  let barEl = $state<HTMLDivElement>();
  let rowEl = $state<HTMLDivElement>();
  let residentEl = $state<HTMLDivElement>();
  let titleEl = $state<HTMLSpanElement>();
  let titleBoxEl = $state<HTMLDivElement>();
  let titleOverflow = $state(false);
  let rateBtnEl = $state<HTMLButtonElement>();
  let sleepBtnEl = $state<HTMLButtonElement>();
  let dotsBtn = $state<HTMLButtonElement>();
  let shuffleEl = $state<HTMLElement>();
  let dotsW = 36;
  let customMin = $state(15);
  let dragging = $state(false);
  let playing = $state(false);
  let rateInput = $state(1);

  const PRESETS = [15, 25, 30, 45, 60, 90];
  const RATE_PRESETS = [0.5, 1, 1.5, 2, 3];

  onMount(() => initRate());

  $effect(() => {
    const a = getAudio();
    const onPlay = () => {
      player.loading = false;
      sleep.fired = false;
    };
    const onTime = () => {
      if (!dragging) progress = a.currentTime;
      reportPlaybackState(duration, a.currentTime); // 系统媒体浮层进度
    };
    const onMeta = () => {
      duration = Number.isFinite(a.duration) ? a.duration : 0;
    };
    const onDurChange = () => {
      duration = Number.isFinite(a.duration) ? a.duration : 0;
      player.loading = false;
    };
    const onCanPlay = () => {
      duration = Number.isFinite(a.duration) ? a.duration : 0;
      player.loading = false;
    };
    const onWaiting = () => (player.loading = true);
    const onPlaying = () => (player.loading = false);
    const onEnded = () => onTrackEnded();
    const onErr = () => (player.loading = false);
    a.addEventListener('play', onPlay);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onDurChange);
    a.addEventListener('canplay', onCanPlay);
    a.addEventListener('waiting', onWaiting);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onErr);
    const onPlaySt = () => (playing = true);
    const onPauseSt = () => (playing = false);
    a.addEventListener('play', onPlaySt);
    a.addEventListener('pause', onPauseSt);
    playing = !a.paused; // 挂载即对齐真值
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onDurChange);
      a.removeEventListener('canplay', onCanPlay);
      a.removeEventListener('waiting', onWaiting);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onErr);
      a.removeEventListener('play', onPlaySt);
      a.removeEventListener('pause', onPauseSt);
    };
  });

  // 倍速同步：切歌或改档后统一应用到 audio 单例（audio 复用，防 track 切换丢档）
  $effect(() => {
    const track = player.track;
    const rate = player.playbackRate;
    if (track) getAudio().playbackRate = rate;
  });

  // 倍速面板输入框跟随当前倍速
  $effect(() => {
    rateInput = player.playbackRate;
  });

  // 被抢占/假播放纠偏：状态说播放但音频没响 → 立即拉回暂停显示；回前台再核一次
  $effect(() => {
    if (!player.track) return;
    const iv = setInterval(() => {
      if (playing && getAudio().paused) playing = false;
    }, 1000);
    const onVis = () => {
      if (!document.hidden && playing && getAudio().paused) playing = false;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  });

  function toggle() {
    const a = getAudio();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function ratioAt(clientX: number, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function seekTo(clientX: number, el: HTMLElement) {
    const a = getAudio();
    if (!duration) return;
    a.currentTime = ratioAt(clientX, el) * duration;
    progress = a.currentTime;
  }

  function onSeekDown(e: PointerEvent) {
    if (!duration) return;
    const el = e.currentTarget as HTMLElement;
    dragging = true;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略不支持的场景 */
    }
    seekTo(e.clientX, el);
  }

  function onSeekMove(e: PointerEvent) {
    if (!dragging) return;
    seekTo(e.clientX, e.currentTarget as HTMLElement);
  }

  function onSeekUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  }

  function seek(e: MouseEvent) {
    seekTo(e.clientX, e.currentTarget as HTMLElement);
  }

  function sleepLabel() {
    if (sleep.afterTrack) return '本曲后';
    if (sleep.until != null) return fmtClockShort(sleep.remaining);
    return '';
  }

  function pick(minutes: number | null, afterTrack = false) {
    startSleep(minutes, afterTrack);
    sleepOpen = false;
  }

  // 倍速按钮角标：整数省小数，否则两位小数
  function rateLabel() {
    const r = player.playbackRate;
    return (Number.isInteger(r) ? String(r) : r.toFixed(2)) + 'x';
  }

  function applyRateInput() {
    const v = Number(rateInput);
    if (Number.isFinite(v)) setRate(v);
  }

  function closePlayer() {
    getAudio().pause();
    player.track = null;
  }

  // 缓存折叠级按钮实测宽（仅可见时更新，进菜单后保留上次缓存）
  function setW(k: FoldKey, el?: HTMLElement) {
    if (!el) return;
    const w = el.offsetWidth;
    if (w && widths[k] !== w) widths[k] = w;
  }

  function needFor(fold: number, resident: number, gap: number): number {
    const vis = FOLD_ORDER.slice(fold) as readonly FoldKey[];
    // foldCount>0 就渲染 ⋮（fold=3 时它是折进菜单的唯一入口），宽度计入
    const dots = fold > 0 ? dotsW : 0;
    const wSum = vis.reduce((s, k) => s + (widths[k] ?? 0), 0);
    const items = 1 + vis.length + (dots > 0 ? 1 : 0);
    return resident + dots + wSum + gap * Math.max(0, items - 1);
  }

  // 从「全不折」贪心翻折：放不下就依次折倍速 → 随机 → 睡眠
  function recalc() {
    if (typeof window === 'undefined') return;
    const bar = barEl;
    const row = rowEl;
    const res = residentEl;
    if (!bar || !row || !res) return;
    setW('rate', rateBtnEl);
    setW('shuffle', shuffleEl);
    setW('sleep', sleepBtnEl);
    if (dotsBtn?.offsetWidth) dotsW = dotsBtn.offsetWidth;
    // 单行档（≥480）可用宽度 = bar - padding24 - 标题min - 进度min - 时间
    const barW = bar.clientWidth;
    const avail = barW - 24 - TITLE_MIN - PROGRESS_MIN - (barW < 640 ? 45 : 90);
    const residentW = res.offsetWidth;
    if (!avail || !residentW) return;
    const gap = parseFloat(getComputedStyle(row).columnGap || '0') || 0;
    let fold = 0;
    while (fold < FOLD_ORDER.length && needFor(fold, residentW, gap) > avail) fold++;
    // 全折仍 > avail（约 <480 才会发生）→ 两行退路
    const overflow = needFor(fold, residentW, gap) > avail;
    if (fold !== foldCount) foldCount = fold;
    if (stacked !== overflow) stacked = overflow;
    if (foldCount === 0 && menuOpen) menuOpen = false;
  }

  // 根容器尺寸变化 → 重算折叠（浏览器守卫；首个回调一帧内校正）
  $effect(() => {
    if (!barEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recalc());
    ro.observe(barEl);
    return () => ro.disconnect();
  });

  // 常驻宽随状态变化（队列显隐 / 计数 / 徽标文字）或折叠档位切换后再核一次
  $effect(() => {
    void player.playlist.length;
    void total;
    void pos;
    void player.playbackRate;
    void sleep.until;
    void sleep.afterTrack;
    void foldCount;
    void player.track?.clip.title;
    void player.loading;
    recalc();
    // 标题溢出检测：放不下 → 视觉隐藏（opacity-0，文本仍在 DOM 供浏览器查找）
    if (titleEl && titleBoxEl) titleOverflow = titleEl.scrollWidth > titleBoxEl.clientWidth + 1;
  });

  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });

  // 副信息：日期 + 切片绝对起止时间（替代内部录像文件名）
  const whenLabel = $derived.by(() => {
    const t = player.track;
    if (!t) return '';
    const md = dateCard(t.rec.start).md;
    const a = clock(t.rec.start + t.clip.offsetStart);
    const b = clock(t.rec.start + t.clip.offsetEnd);
    return `${md} ${a}–${b}`;
  });

  const total = $derived(player.playlist.length || (player.track ? (player.track.rec.clips?.length ?? 0) : 0));
  const pos = $derived(player.pos >= 0 ? player.pos : (player.track?.index ?? 0));
  const pct = $derived(duration > 0 ? Math.min(100, (progress / duration) * 100) : 0);
</script>

{#snippet shuffleControl(variant: 'icon' | 'row')}
  <button
    class={(variant === 'icon'
      ? 'flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-base-200 '
      : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-base-200 ') +
      (player.shuffle ? 'text-accent' : '')}
    onclick={toggleShuffle}
    aria-label="随机播放"
    aria-pressed={player.shuffle}
    title={player.shuffle ? '随机播放：开' : '随机播放：关'}
  >
    <Shuffle class="h-4 w-4" />
    {#if variant === 'row'}<span>随机播放{player.shuffle ? '：开' : ''}</span>{/if}
  </button>
{/snippet}

{#snippet sleepPanel()}
  <div class="px-1 pb-1 text-2xs uppercase tracking-wide opacity-50">睡眠定时器</div>
  <div class="grid grid-cols-3 gap-1">
    {#each PRESETS as m (m)}
      <button class="rounded-md px-2 py-1 text-xs tabular-nums transition hover:bg-base-200" onclick={() => pick(m)}>
        {m}分
      </button>
    {/each}
  </div>
  <button
    class="mt-1 w-full rounded-md px-2 py-1 text-left text-xs transition hover:bg-base-200"
    onclick={() => pick(null, true)}
  >
    播完当前曲目后就停
  </button>
  <div class="mt-1 flex items-center gap-1 border-t border-base-300 pt-1.5">
    <input
      type="number"
      min="1"
      max="600"
      bind:value={customMin}
      class="w-16 rounded-md border border-base-300 bg-base-200 px-1.5 py-0.5 text-xs tabular-nums"
      aria-label="自定义睡眠分钟数"
    />
    <span class="text-2xs opacity-60">分钟</span>
    <button
      class="ml-auto rounded-md bg-accent px-2 py-0.5 text-2xs text-accent-content transition hover:opacity-90"
      onclick={() => Number(customMin) > 0 && pick(Number(customMin))}
    >
      开始
    </button>
  </div>
  {#if sleep.until != null || sleep.afterTrack}
    <button
      class="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-warning transition hover:bg-base-200"
      onclick={() => { cancelSleep(); sleepOpen = false; }}
    >
      取消定时
    </button>
  {/if}
{/snippet}

{#snippet ratePanel()}
  <div class="px-1 pb-1 text-2xs uppercase tracking-wide opacity-50">播放倍速</div>
  <input
    type="range"
    min="0.01"
    max="8"
    step="0.01"
    bind:value={rateInput}
    oninput={applyRateInput}
    class="w-full accent-accent"
    aria-label="播放倍速滑杆"
  />
  <div class="mt-1 flex items-center gap-1">
    <input
      type="number"
      min="0.01"
      max="8"
      step="0.01"
      bind:value={rateInput}
      onchange={applyRateInput}
      class="w-16 rounded-md border border-base-300 bg-base-200 px-1.5 py-0.5 text-xs tabular-nums"
      aria-label="倍速数值"
    />
    <span class="text-2xs opacity-60">x</span>
    <span class="ml-auto text-xs tabular-nums">{player.playbackRate.toFixed(2)}x</span>
  </div>
  <div class="mt-1 grid grid-cols-5 gap-1">
    {#each RATE_PRESETS as r (r)}
      <button
        class="rounded-md px-1 py-1 text-2xs tabular-nums transition hover:bg-base-200 {player.playbackRate === r ? 'bg-accent text-accent-content' : ''}"
        onclick={() => setRate(r)}
      >
        {r}x
      </button>
    {/each}
  </div>
  <button
    class="mt-1 w-full rounded-md px-2 py-1 text-left text-xs transition hover:bg-base-200"
    onclick={() => { setRate(1); rateOpen = false; }}
  >
    重置 1x
  </button>
{/snippet}

{#snippet rateRow()}
  <div class="flex items-center gap-2 px-1 py-1">
    <span class="shrink-0 text-xs">倍速</span>
    <input
      type="range"
      min="0.01"
      max="8"
      step="0.01"
      bind:value={rateInput}
      oninput={applyRateInput}
      class="min-w-0 flex-1 accent-accent"
      aria-label="播放倍速滑杆"
    />
    <span class="shrink-0 text-xs tabular-nums">{player.playbackRate.toFixed(2)}x</span>
  </div>
{/snippet}

{#if player.track}
  {@const t = player.track}
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 backdrop-blur">
    <div class="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center gap-2 px-3 py-1 sm:gap-3 sm:px-4" bind:this={barEl}>
      <!-- 左区：播放/暂停 + 曲目信息 -->
      <div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <button
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-content transition hover:opacity-90"
          onclick={toggle}
          aria-label={playing ? '暂停' : '播放'}
        >
          {#if player.loading}
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
          {:else if playing}
            <Pause class="h-5 w-5" />
          {:else}
            <Play class="h-5 w-5" />
          {/if}
        </button>

        <div class="min-w-[110px] flex-1" bind:this={titleBoxEl}>
          <div class="flex items-baseline gap-2">
            <span
              bind:this={titleEl}
              class="{titleOverflow ? 'opacity-0 select-none' : 'truncate'} text-sm font-medium"
              aria-live="polite"
              title={t.clip.title || '（未识别）'}
            >{t.clip.title || '（未识别）'}</span>
            {#if sleep.until != null || sleep.afterTrack}
              <span class="shrink-0 text-2xs text-accent tabular-nums flex items-center gap-0.5"><MoonStar class="h-3 w-3" />{sleepLabel()}</span>
            {/if}
            {#if player.loading}
              <span class="shrink-0 text-2xs text-accent">加载中…</span>
            {/if}
            {#if sleep.fired}
              <span class="shrink-0 text-2xs text-warning">睡眠定时已停止</span>
            {/if}
          </div>
          <div class="mt-0.5 hidden items-center gap-2 text-2xs opacity-60 sm:flex">
            <span class="shrink-0 tabular-nums">{whenLabel}</span>
          </div>
        </div>
      </div>

      <!-- 中区：进度条 + 时间 -->
      <div class="flex min-w-[80px] flex-1 items-center gap-2">
        <div
          class="relative h-1.5 min-w-0 flex-1 cursor-pointer touch-none rounded-full bg-base-200"
          role="slider" tabindex="0"
          aria-label="进度" aria-valuemin="0"
          aria-valuenow={Math.round(progress)}
          aria-valuemax={duration ? Math.round(duration) : undefined}
          onpointerdown={onSeekDown}
          onpointermove={onSeekMove}
          onpointerup={onSeekUp}
          onclick={seek}
        >
          <div class="h-1.5 rounded-full bg-accent" style:width={pct + '%'}></div>
        </div>
        <div class="shrink-0 text-2xs tabular-nums opacity-60">
          {player.loading ? '加载中…' : fmtClockShort(progress)}
          {#if !player.loading && duration}<span class="hidden sm:inline"> / {fmtClockShort(duration)}</span>{/if}
        </div>
      </div>

      <!-- 右区：常驻级平铺 + 折叠级按空间进 ⋮ 菜单 -->
      <div class="flex items-center gap-1 {stacked ? 'order-last w-full basis-full justify-around' : 'shrink-0 justify-start'}" bind:this={rowEl}>
        <!-- 常驻级（永不折叠）：上一首 / 计数 / 下一首 / 队列 / 关闭 -->
        <div class="flex items-center gap-0.5 sm:gap-1" bind:this={residentEl}>
          <button class="rounded-md p-2 transition hover:bg-base-200 disabled:opacity-30"
            onclick={() => step(-1)} disabled={pos <= 0} aria-label="上一首">
            <SkipBack class="h-4 w-4" />
          </button>
          <span class="text-2xs tabular-nums opacity-60">{pos + 1}/{total}</span>
          <button class="rounded-md p-2 transition hover:bg-base-200 disabled:opacity-30"
            onclick={() => step(1)} disabled={pos >= total - 1} aria-label="下一首">
            <SkipForward class="h-4 w-4" />
          </button>

          {#if player.playlist.length > 0}
            <button
              class="rounded-md p-2 transition hover:bg-base-200 {player.queueOpen ? 'text-accent' : ''}"
              onclick={() => (player.queueOpen = !player.queueOpen)}
              aria-label="播放队列"
              aria-expanded={player.queueOpen}
              title="播放队列"
            >
              <ListMusic class="h-4 w-4" />
            </button>
          {/if}

          <button
            class="rounded-md p-2 transition hover:bg-base-200"
            onclick={closePlayer}
            aria-label="关闭播放器"
            title="关闭播放器"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- 折叠级：倍速（最先折） -->
        {#if foldCount < 1}
          <div class="relative">
            <button
              bind:this={rateBtnEl}
              class="relative rounded-md p-2 transition hover:bg-base-200 {player.playbackRate !== 1 ? 'text-accent' : ''}"
              onclick={() => (rateOpen = !rateOpen)}
              aria-label="播放倍速"
              aria-expanded={rateOpen}
              title="播放倍速"
            >
              <Gauge class="h-4 w-4" />
              <span class="absolute -top-1 -right-1 rounded px-0.5 text-2xs leading-tight tabular-nums {player.playbackRate !== 1 ? 'bg-accent text-accent-content' : 'bg-base-200'}">{rateLabel()}</span>
            </button>
            {#if rateOpen}
              <div class="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-base-300 bg-base-100 p-2 shadow-lg">
                {@render ratePanel()}
              </div>
            {/if}
          </div>
        {/if}

        <!-- 折叠级：随机播放（次折） -->
        {#if foldCount < 2}
          <span class="inline-flex" bind:this={shuffleEl}>
            {@render shuffleControl('icon')}
          </span>
        {/if}

        <!-- 折叠级：睡眠定时器（最后折） -->
        {#if foldCount < 3}
          <div class="relative">
            <button
              bind:this={sleepBtnEl}
              class="relative rounded-md p-2 transition hover:bg-base-200 {(sleep.until != null || sleep.afterTrack) ? 'text-accent' : ''}"
              onclick={() => (sleepOpen = !sleepOpen)}
              aria-label="睡眠定时器"
              aria-expanded={sleepOpen}
              title="睡眠定时器"
            >
              <MoonStar class="h-4 w-4" />
              {#if sleepLabel()}
                <span class="absolute -top-1 -right-1 rounded bg-accent px-0.5 text-2xs leading-tight text-accent-content tabular-nums">{sleepLabel()}</span>
              {/if}
            </button>
            {#if sleepOpen}
              <div class="absolute bottom-full right-0 mb-2 w-48 rounded-lg border border-base-300 bg-base-100 p-2 shadow-lg">
                {@render sleepPanel()}
              </div>
            {/if}
          </div>
        {/if}

        <!-- ⋮ 折叠菜单（仅折了钮时出现） -->
        {#if foldCount > 0}
          <div class="relative">
            <button
              bind:this={dotsBtn}
              class="rounded-md p-2 transition hover:bg-base-200"
              onclick={() => (menuOpen = !menuOpen)}
              aria-label="更多功能"
              aria-expanded={menuOpen}
              title="更多功能"
            >
              <MoreVertical class="h-4 w-4" />
            </button>
            {#if menuOpen}
              <div class="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-base-300 bg-base-100 p-2 shadow-lg">
                {#if foldCount >= 1}{@render rateRow()}{/if}
                {#if foldCount >= 2}<div class="mt-1 border-t border-base-300 pt-1">{@render shuffleControl('row')}</div>{/if}
                {#if foldCount >= 3}<div class="mt-1 border-t border-base-300 pt-1">{@render sleepPanel()}</div>{/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
