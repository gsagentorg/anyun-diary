<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { player, getAudio } from '$lib/player.svelte.ts';
  import { hasLyrics, lyricDisplayIndexAt, sameTimeGroupBounds } from '$lib/lyrics';
  import { dateCard } from '$lib/types';
  import { LocateFixed } from 'lucide-svelte';

  /** 统一行高（px）：偏移量按它算，避免测量每行 */
  const LINE_H = 44;
  /** 手动滚动停止后自动恢复跟随的等待（ms；owner 选定 3 秒） */
  const RESUME_MS = 3000;

  let boxEl = $state<HTMLDivElement>();
  let boxH = $state(0);
  let posAudio = $state(0);
  let follow = $state(true);

  /** 程序平滑滚动期间，屏蔽 scroll 事件里的「用户滚动」判定 */
  let suppressUntil = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clock = (epoch: number) =>
    new Date(epoch * 1000).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });

  const clip = $derived(player.track?.clip ?? null);
  const lines = $derived(clip?.lyrics ?? []);
  const clipDur = $derived(clip ? clip.offsetEnd - clip.offsetStart : Infinity);
  const idx = $derived(lyricDisplayIndexAt(clip?.lyrics, posAudio, clipDur));
  /** 同刻多行（合唱/同唱）与收尾超界行（展示层折叠到结尾）：整组快速闪过，每行短暂停留；滚动锚定组首防抖（owner 2026-11-07） */
  const FLASH_MS = 450;
  const group = $derived(sameTimeGroupBounds(clip?.lyrics, idx, clipDur));
  let flashStep = $state(0);
  $effect(() => {
    const g = group;
    flashStep = 0;
    if (!g || g[1] === g[0]) return;
    const lastOffset = g[1] - g[0];
    const iv = setInterval(() => {
      flashStep += 1;
      if (flashStep >= lastOffset) clearInterval(iv);
    }, FLASH_MS);
    return () => clearInterval(iv);
  });
  const shownIdx = $derived(group ? group[0] + Math.min(flashStep, group[1] - group[0]) : idx);
  const activeIdx = $derived(idx < 0 ? 0 : group ? group[0] : idx);

  // 切歌：进度清零（修旧进度残影）+ 回到跟随
  $effect(() => {
    void clip?.file;
    posAudio = 0;
    follow = true;
  });

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

  // 打开面板 = 回到跟随（每次打开都先看当前行）
  $effect(() => {
    if (player.lyricsOpen) follow = true;
  });

  // 跟随：当前行变化 / 恢复跟随 / 容器尺寸变化 → 滚动把当前行摆在中央。
  // 顶部占位已是半个视口高，因此 scrollTop = idx*LINE_H 即居中；开面板/切歌瞬移，行进平滑。
  let lastCenterKey = '';
  $effect(() => {
    if (!follow || boxH <= 0 || !player.track || !boxEl) return;
    const key = (clip?.file ?? '') + ':' + String(player.lyricsOpen);
    const instant = key !== lastCenterKey;
    lastCenterKey = key;
    const max = boxEl.scrollHeight - boxEl.clientHeight;
    const target = Math.max(0, Math.min(max, activeIdx * LINE_H));
    suppressUntil = Date.now() + (instant ? 200 : 600);
    boxEl.scrollTo({ top: target, behavior: instant ? 'auto' : 'smooth' });
  });

  function armAutoResume() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (follow = true), RESUME_MS);
  }

  function markUserScroll() {
    if (Date.now() < suppressUntil) return;
    if (follow) follow = false; // 当前行仍高亮，只是不再自动居中
    armAutoResume();
  }

  function onWheel(e: WheelEvent) {
    if (!e.deltaY) return;
    markUserScroll();
  }

  function onTouchStart() {
    markUserScroll();
  }

  function onPointerDown(e: PointerEvent) {
    // 鼠标拖滚动条；行点击会在 click 里立即恢复跟随，不受影响
    if (e.pointerType === 'mouse') markUserScroll();
  }

  function seekLine(i: number) {
    const a = getAudio();
    a.currentTime = lines[i]?.t ?? 0;
    posAudio = a.currentTime;
    follow = true; // 点行 = 跳这句并立即回跟
  }
</script>

<Sheet
  open={player.lyricsOpen}
  onClose={() => (player.lyricsOpen = false)}
  side="right"
  title={player.track?.clip.title || '（未识别）'}
  scroll={false}
>
  {#if player.track}
    {@const t = player.track}
    {#if hasLyrics(t.clip)}
      <div class="relative h-full">
        <div
          bind:this={boxEl}
          bind:clientHeight={boxH}
          class="lyr-scroll h-full overflow-y-auto overscroll-contain px-3"
          role="region"
          aria-label="歌词"
          tabindex="-1"
          onwheel={onWheel}
          ontouchstart={onTouchStart}
          onpointerdown={onPointerDown}
        >
          <div
            style:padding-top="{Math.max(0, (boxH - LINE_H) / 2)}px"
            style:padding-bottom="{Math.max(0, (boxH - LINE_H) / 2)}px"
          >
            {#each lines as l, i (i)}
              <button
                class="lyr-line {i === shownIdx ? 'text-accent font-semibold' : 'opacity-55'}"
                class:lyr-active={i === shownIdx}
                onclick={() => seekLine(i)}
                title="点击跳到这句"
              >
                <span class="min-w-0 truncate">{l.text || '…'}</span>
              </button>
            {/each}
          </div>
        </div>
        {#if !follow}
          <button
            class="absolute right-4 bottom-4 flex items-center gap-1 rounded-full border border-base-300 bg-base-100/90 px-3 py-1.5 text-xs shadow-md transition hover:border-accent"
            onclick={() => (follow = true)}
          >
            <LocateFixed class="h-3.5 w-3.5" /> 回到当前
          </button>
        {/if}
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
  /* 滚动条视觉：细、圆角、半透明，贴面板右缘一根，不再出现系统宽条 */
  .lyr-scroll {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--color-base-content) 22%, transparent) transparent;
  }
  .lyr-scroll::-webkit-scrollbar {
    width: 6px;
  }
  .lyr-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .lyr-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in oklab, var(--color-base-content) 22%, transparent);
    border-radius: 999px;
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
