<script lang="ts">
  import { player, step, getAudio } from './player.svelte';
  import { fmtOffset, fmtClockShort, fmtDur } from './types';
  import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-svelte';

  let playing = $state(false);
  let progress = $state(0);
  let duration = $state(0);

  $effect(() => {
    const a = getAudio();
    const onPlay = () => {
      playing = true;
      player.loading = false;
    };
    const onPause = () => (playing = false);
    const onTime = () => (progress = a.currentTime);
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
    const onEnded = () => step(1);
    const onErr = () => (player.loading = false);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onDurChange);
    a.addEventListener('canplay', onCanPlay);
    a.addEventListener('waiting', onWaiting);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onErr);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onDurChange);
      a.removeEventListener('canplay', onCanPlay);
      a.removeEventListener('waiting', onWaiting);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onErr);
    };
  });

  function toggle() {
    const a = getAudio();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function seek(e: MouseEvent) {
    const a = getAudio();
    if (!duration) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * duration;
  }

  const total = $derived(player.track ? (player.track.rec.clips?.length ?? 0) : 0);
  const pct = $derived(duration > 0 ? Math.min(100, (progress / duration) * 100) : 0);
</script>

{#if player.track}
  {@const t = player.track}
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
      <button
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-content transition hover:opacity-90"
        onclick={toggle}
        aria-label={playing ? '暂停' : '播放'}
      >
        {#if player.loading}
          <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
        {:else if playing}
          <Pause class="h-4 w-4" />
        {:else}
          <Play class="h-4 w-4" />
        {/if}
      </button>

      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-sm font-medium">{t.clip.title || '（未识别）'}</span>
          {#if player.loading}
            <span class="shrink-0 text-[10px] text-accent">加载中…</span>
          {/if}
        </div>
        <div class="mt-0.5 flex items-center gap-2 text-[10px] opacity-60">
          <span class="shrink-0">录像 +{fmtOffset(t.clip.offsetStart)}</span>
          <span class="truncate">{t.rec.file}</span>
        </div>
        <div
          class="mt-1 h-1 cursor-pointer rounded-full bg-base-300"
          role="slider" tabindex="0"
          aria-label="进度" aria-valuenow={Math.round(progress)}
          aria-valuemax={duration ? Math.round(duration) : undefined}
          onclick={seek}
        >
          <div class="h-1 rounded-full bg-accent" style:width={pct + '%'}></div>
        </div>
      </div>

      <div class="shrink-0 text-[10px] tabular-nums opacity-60">
        {player.loading ? '加载中…' : `${fmtClockShort(progress)}${duration ? ' / ' + fmtClockShort(duration) : ''}`}
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <button class="rounded p-1.5 transition hover:bg-base-200 disabled:opacity-30"
          onclick={() => step(-1)} disabled={t.index <= 0} aria-label="上一首">
          <SkipBack class="h-4 w-4" />
        </button>
        <span class="text-[10px] tabular-nums opacity-60">{t.index + 1}/{total}</span>
        <button class="rounded p-1.5 transition hover:bg-base-200 disabled:opacity-30"
          onclick={() => step(1)} disabled={t.index >= total - 1} aria-label="下一首">
          <SkipForward class="h-4 w-4" />
        </button>
        <button class="ml-1 rounded p-1.5 transition hover:bg-base-200"
          onclick={() => { getAudio().pause(); player.track = null; }} aria-label="关闭">
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>
{/if}
