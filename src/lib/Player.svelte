<script lang="ts">
  import { player, step, getAudio, sleep, startSleep, cancelSleep, onTrackEnded, toggleShuffle, reportPlaybackState } from './player.svelte';
  import { fmtClockShort, dateCard } from './types';
  import { Pause, Play, SkipBack, SkipForward, X, MoonStar, Shuffle, ListMusic } from 'lucide-svelte';

  let progress = $state(0);
  let duration = $state(0);
  let sleepOpen = $state(false);
  let customMin = $state(15);
  let dragging = $state(false);
  let playing = $state(false);

  const PRESETS = [10, 15, 30, 45, 60, 90];

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

  function closePlayer() {
    getAudio().pause();
    player.track = null;
  }

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

{#if player.track}
  {@const t = player.track}
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 backdrop-blur">
    <div class="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-4">
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

        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="truncate text-sm font-medium" aria-live="polite">{t.clip.title || '（未识别）'}</span>
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
      <div class="flex min-w-0 flex-1 items-center gap-2">
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
          {player.loading ? '加载中…' : `${fmtClockShort(progress)}${duration ? ' / ' + fmtClockShort(duration) : ''}`}
        </div>
      </div>

      <!-- 右区：上/下一首 + 计数 + 控制 -->
      <div class="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <button class="rounded-md p-2 transition hover:bg-base-200 disabled:opacity-30"
          onclick={() => step(-1)} disabled={pos <= 0} aria-label="上一首">
          <SkipBack class="h-4 w-4" />
        </button>
        <span class="text-2xs tabular-nums opacity-60">{pos + 1}/{total}</span>
        <button class="rounded-md p-2 transition hover:bg-base-200 disabled:opacity-30"
          onclick={() => step(1)} disabled={pos >= total - 1} aria-label="下一首">
          <SkipForward class="h-4 w-4" />
        </button>

        <!-- >=1024px：随机与睡眠平铺 -->
        <div class="hidden items-center gap-1 lg:flex">
          {@render shuffleControl('icon')}
          <div class="relative">
            <button
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
        </div>

        <!-- 播放队列（有队列时直接平铺，与关闭按钮同级） -->
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

        <!-- 关闭（所有断点直接平铺） -->
        <button
          class="rounded-md p-2 transition hover:bg-base-200"
          onclick={closePlayer}
          aria-label="关闭播放器"
          title="关闭播放器"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
{/if}
