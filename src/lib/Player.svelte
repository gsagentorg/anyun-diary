<script lang="ts">
  import { player, step, getAudio } from './player.svelte';
  import { fmtClock, fmtDur, sourceLabel } from './types';
  import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-svelte';

  let playing = $state(false);
  let progress = $state(0);
  let duration = $state(0);
  let ready = $state(false);

  $effect(() => {
    const a = getAudio();
    const onPlay = () => (playing = true);
    const onPause = () => (playing = false);
    const onTime = () => (progress = a.currentTime);
    const onMeta = () => {
      duration = a.duration || 0;
      ready = true;
    };
    const onEnded = () => step(1);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnded);
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
</script>

{#if player.track}
  {@const t = player.track}
  {@const absStart = t.rec.start + t.clip.offsetStart}
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-base-300 bg-base-100/95 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
      <button
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-content transition hover:opacity-90"
        onclick={toggle}
        aria-label={playing ? '暂停' : '播放'}
      >
        {#if playing}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
      </button>

      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-sm font-medium">{t.clip.title || '（未识别）'}</span>
          <span class="shrink-0 text-[10px] opacity-60">{sourceLabel(t.clip.source)}</span>
        </div>
        <div class="mt-0.5 flex items-center gap-2 text-[10px] opacity-60">
          <span class="shrink-0">{fmtClock(absStart)}</span>
          <span class="truncate">{t.rec.file}</span>
        </div>
        <div
          class="mt-1 h-1 cursor-pointer rounded-full bg-base-300"
          role="slider" tabindex="0"
          aria-label="进度" aria-valuenow={Math.round(progress)}
          onclick={seek}
        >
          <div
            class="h-1 rounded-full bg-accent"
            style:width={(duration ? (progress / duration) * 100 : 0) + '%'}
          ></div>
        </div>
      </div>

      <div class="shrink-0 text-[10px] tabular-nums opacity-60">
        {fmtDur(progress)}{duration ? ' / ' + fmtDur(duration) : ''}
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
