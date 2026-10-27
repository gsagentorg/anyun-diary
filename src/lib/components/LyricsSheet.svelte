<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { player, getAudio } from '$lib/player.svelte';
  import { hasLyrics, lyricIndexAt } from '$lib/lyrics';
  import { dateCard } from '$lib/types';

  /** 统一行高（px）：偏移量按它算，避免测量每行 */
  const LINE_H = 44;

  let posAudio = $state(0);
  let boxH = $state(0);

  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });

  const clip = $derived(player.track?.clip ?? null);
  const lines = $derived(clip?.lyrics ?? []);
  const idx = $derived(lyricIndexAt(clip?.lyrics, posAudio));
  // 未到第一行时也把第一行摆在中央（idx=-1 → 用 0 算偏移）
  const activeIdx = $derived(idx < 0 ? 0 : idx);
  const offset = $derived(boxH > 0 ? boxH / 2 - (activeIdx + 0.5) * LINE_H : 0);

  // 打开时按 250ms 读一次本地音频进度（页面别处已有全局监听，不重复挂）
  $effect(() => {
    if (!player.lyricsOpen || !player.track) return;
    const a = getAudio();
    posAudio = a.currentTime || 0;
    const iv = setInterval(() => {
      posAudio = getAudio().currentTime || 0;
    }, 250);
    return () => clearInterval(iv);
  });

  function seekLine(i: number) {
    const a = getAudio();
    a.currentTime = lines[i]?.t ?? 0;
    posAudio = a.currentTime;
  }
</script>

<Sheet
  open={player.lyricsOpen}
  onClose={() => (player.lyricsOpen = false)}
  side="right"
  title={player.track?.clip.title || '（未识别）'}
>
  {#if player.track}
    {@const t = player.track}
    {#if hasLyrics(t.clip)}
      <div class="flex h-full min-h-[45vh] flex-col">
        <div class="relative min-h-0 flex-1 overflow-hidden" bind:clientHeight={boxH}>
          <div class="lyr-track" style:transform="translateY({offset}px)">
            {#each lines as l, i (i)}
              <button
                class="lyr-line {i === idx ? 'text-accent font-semibold' : 'opacity-55'}"
                class:lyr-active={i === idx}
                onclick={() => seekLine(i)}
                title="点击跳到这句"
              >
                <span class="min-w-0 truncate">{l.text || '…'}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    {:else}
      <div class="flex h-full min-h-0 flex-col items-center justify-center gap-1">
        <span class="text-sm opacity-60">暂无歌词</span>
        <span class="text-2xs tabular-nums opacity-40">
          {dateCard(t.rec.start).md} {clock(t.rec.start + t.clip.offsetStart)}
        </span>
      </div>
    {/if}
  {:else}
    <div class="flex h-full min-h-0 items-center justify-center text-sm opacity-60">暂无歌词</div>
  {/if}
</Sheet>

<style>
  .lyr-track {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    transition: transform 300ms ease;
    will-change: transform;
  }
  .lyr-line {
    display: flex;
    width: 100%;
    height: 44px;
    align-items: center;
    justify-content: center;
    padding: 0 0.25rem;
    text-align: center;
    font-size: 0.95rem;
    line-height: 1.5;
    border-radius: var(--radius-md, 0.375rem);
    transition: color 200ms ease, opacity 200ms ease, font-size 200ms ease;
  }
  .lyr-line:hover {
    opacity: 0.95;
    background: var(--color-base-200);
  }
  .lyr-active {
    font-size: 1.125rem;
  }
</style>
