<script lang="ts">
  import Sheet from './Sheet.svelte';
  import StateHint from './StateHint.svelte';
  import { player, playAt, removeAt, clearQueue, moveTrack } from '$lib/player.svelte';
  import { fmtDur } from '$lib/types';
  import { X } from 'lucide-svelte';

  const list = $derived(player.playlist);
  const total = $derived.by(() =>
    list.reduce((a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart), 0),
  );

  const LONG_PRESS_MS = 350;
  const MOVE_SLOP_PX = 8;

  let dragMode = $state(false);
  let dragIdx = $state(-1);
  let dragDelta = $state(0);
  let wasDragged = $state(false);

  let pressEl: HTMLElement | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let touchBlocker: ((e: TouchEvent) => void) | null = null;
  let startX = 0;
  let startY = 0;
  let pointerId = -1;
  let rowH = 0;
  let baseDelta = 0;

  function endPressTimer() {
    if (pressTimer !== undefined) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  }

  function enterDrag(i: number, el: HTMLElement) {
    dragMode = true;
    dragIdx = i;
    dragDelta = 0;
    baseDelta = 0;
    wasDragged = true;
    pressEl = el;
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(pointerId);
      } catch {
        // pointer 已失效则放弃捕获，拖动逻辑不受影响
      }
    }
    touchBlocker = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('touchmove', touchBlocker, { passive: false });
  }

  function exitDrag() {
    dragMode = false;
    dragIdx = -1;
    dragDelta = 0;
    baseDelta = 0;
    if (touchBlocker && pressEl) pressEl.removeEventListener('touchmove', touchBlocker);
    touchBlocker = null;
    pressEl = null;
  }

  function onRowPointerDown(e: PointerEvent, i: number) {
    if (dragMode || pressTimer !== undefined) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    pressEl = el;
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    rowH = el.offsetHeight || 32;
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      enterDrag(i, el);
    }, LONG_PRESS_MS);
  }

  function onRowPointerMove(e: PointerEvent) {
    if (!dragMode) {
      if (pressTimer !== undefined && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_SLOP_PX) {
        endPressTimer();
      }
      return;
    }
    if (e.pointerId !== pointerId) return;
    const raw = e.clientY - startY;
    const offsetRows = (raw - baseDelta) / rowH;
    const step = offsetRows > 0.5 ? 1 : offsetRows < -0.5 ? -1 : 0;
    if (step !== 0) {
      const to = dragIdx + step;
      if (to >= 0 && to < list.length) {
        moveTrack(dragIdx, to);
        dragIdx = to;
        baseDelta += step * rowH;
      }
    }
    dragDelta = raw - baseDelta;
  }

  function onRowPointerEnd(e: PointerEvent) {
    endPressTimer();
    if (!dragMode || e.pointerId !== pointerId) return;
    exitDrag();
  }
</script>

<Sheet open={player.queueOpen} onClose={() => (player.queueOpen = false)} title="播放队列">
  <div class="flex items-center justify-between">
    <span class="rounded-full bg-accent/15 px-2 py-0.5 text-2xs tabular-nums opacity-80">
      {list.length} 首 · {fmtDur(total)}
    </span>
  </div>

  {#if list.length === 0}
    <StateHint kind="empty" />
  {:else}
    <ol class="mt-3 space-y-1 text-xs">
      {#each list as t, i (t.clip.file + '@' + i)}
        <li>
          <div
            class="flex items-center gap-1 rounded border-l-2 px-1 py-0.5 {i === player.pos
              ? 'border-accent bg-accent-muted'
              : 'border-transparent'} {dragMode && dragIdx === i
              ? 'relative z-20 scale-105 bg-base-100 shadow-lg ring-1 ring-accent select-none'
              : ''}"
            style={dragMode && dragIdx === i ? `transform: translateY(${dragDelta}px)` : undefined}
            aria-current={i === player.pos ? 'true' : undefined}
            onpointerdown={(e) => onRowPointerDown(e, i)}
            onpointermove={onRowPointerMove}
            onpointerup={onRowPointerEnd}
            onpointercancel={onRowPointerEnd}
          >
            <button
              class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition hover:bg-base-200"
              onclick={() => {
                if (wasDragged) {
                  wasDragged = false;
                  return;
                }
                playAt(i);
              }}
            >
              <span class="w-6 shrink-0 text-2xs tabular-nums opacity-50">{i + 1}</span>
              <span class="truncate font-medium">{t.clip.title || '（未识别）'}</span>
              <span class="ml-auto shrink-0 text-2xs tabular-nums opacity-50">
                {fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}
              </span>
            </button>
            <button
              class="shrink-0 rounded p-1 transition hover:bg-base-200"
              onclick={() => { wasDragged = false; removeAt(i); }}
              aria-label="移出队列"
              title="移出队列"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
        </li>
      {/each}
    </ol>

    <div class="mt-3 flex items-center gap-2 border-t border-base-300 pt-3">
      <button
        class="rounded border border-base-300 px-2.5 py-1 text-xs transition hover:bg-base-200 disabled:opacity-40"
        onclick={clearQueue}
        disabled={list.length === 0}
        title="移除除当前播放外的全部"
      >
        清空
      </button>
      <button
        class="ml-auto rounded border border-base-300 px-2.5 py-1 text-xs transition hover:bg-base-200"
        onclick={() => (player.queueOpen = false)}
      >
        关闭
      </button>
    </div>
  {/if}
</Sheet>
