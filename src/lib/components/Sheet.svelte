<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';

  let {
    open,
    onClose,
    side = 'right',
    title,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    side?: 'right' | 'bottom';
    title?: string;
    children?: Snippet;
  } = $props();

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  // Esc 只在打开时监听
  $effect(() => {
    if (!open) return;
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
</script>

<!-- 遮罩：打开时拦截点击并关闭 -->
<div
  class="fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 {open
    ? 'opacity-100'
    : 'pointer-events-none opacity-0'}"
  onclick={onClose}
  aria-hidden={!open}
></div>

<!-- 面板始终保留在 DOM，用 data-open 驱动 transform 过渡，关闭不销毁子组件 -->
<div
  class="sheet-panel"
  data-side={side}
  data-open={open}
  role="dialog"
  aria-modal="true"
  aria-label={title}
  aria-hidden={!open}
  inert={!open}
>
  <div class="flex shrink-0 items-center justify-between border-b border-base-300 px-4 py-3">
    <h2 class="truncate text-sm font-semibold">{title ?? ''}</h2>
    <button
      class="shrink-0 rounded-md p-1.5 transition hover:bg-base-200"
      onclick={onClose}
      aria-label="关闭"
    >
      <X class="h-4 w-4" />
    </button>
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    {@render children?.()}
  </div>
</div>

<style>
  /* 默认右侧抽屉 */
  .sheet-panel {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    top: 0;
    bottom: 0;
    right: 0;
    width: 24rem;
    max-width: 85vw;
    background: var(--color-base-100);
    border-left: 1px solid var(--color-base-300);
    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    transform: translateX(100%);
    transition: transform 200ms ease-out;
  }
  .sheet-panel[data-side='right'][data-open='true'] {
    transform: translateX(0);
  }

  /* 显式 bottom：底部抽屉 */
  .sheet-panel[data-side='bottom'] {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-width: none;
    max-height: 70vh;
    border-left: none;
    border-top: 1px solid var(--color-base-300);
    border-top-left-radius: var(--radius-lg);
    border-top-right-radius: var(--radius-lg);
    transform: translateY(100%);
  }
  .sheet-panel[data-side='bottom'][data-open='true'] {
    transform: translateY(0);
  }

  /* <768px：right 自动变为底部抽屉（外部用法不变） */
  @media (max-width: 767px) {
    .sheet-panel[data-side='right'] {
      top: auto;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      max-width: none;
      max-height: 70vh;
      border-left: none;
      border-top: 1px solid var(--color-base-300);
      border-top-left-radius: var(--radius-lg);
      border-top-right-radius: var(--radius-lg);
      transform: translateY(100%);
    }
    .sheet-panel[data-side='right'][data-open='true'] {
      transform: translateY(0);
    }
  }
</style>
