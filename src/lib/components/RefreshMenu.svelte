<script lang="ts">
  import { backend, recoverCatalog } from '$lib/backend.svelte';
  import { RefreshCw } from 'lucide-svelte';

  // 顶栏刷新菜单：web 与 App 都可用（普通 DOM 按钮，不依赖浏览器 chrome，也不需要原生插件）。
  // 「刷新数据」= 强制恢复目录：退休挂住的在途请求再重新发起，绝不清空播放队列/后端地址/缓存。
  // 「重新载入页面」= 显式确认后 window.location.reload()；页面自身永不自动重载。
  // 说明：若 JS 运行时已彻底死锁，任何网页按钮（包括这里）都不可用——本菜单不承诺覆盖那种场景。
  let open = $state(false);
  let confirmReload = $state(false);
  const busy = $derived(backend.pending);
  const monthCount = $derived((backend.manifest?.months ?? []).filter((m) => m.available).length);

  function close() {
    open = false;
    confirmReload = false;
  }
  function refreshData() {
    // 永不禁用：卡住时再点一次即退休旧请求重新发起（recoverCatalog 内部会合并同一瞬间的多次触发）。
    recoverCatalog({ force: true });
  }
  function reloadNow() {
    window.location.reload();
  }
</script>

<div class="relative">
  <button
    class="flex items-center gap-1.5 rounded-full border border-base-300 px-3 py-1 text-sm transition hover:bg-base-200"
    aria-haspopup="dialog"
    aria-expanded={open}
    title="刷新"
    onclick={() => (open ? close() : (open = true))}
  >
    <RefreshCw class="h-4 w-4 {busy ? 'animate-spin' : ''}" /> 刷新
  </button>

  {#if open}
    <div class="fixed inset-0 z-40" role="presentation" onclick={close}></div>
    <div
      class="absolute right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-base-300 bg-base-100 p-3 shadow-lg"
      role="dialog"
      aria-label="刷新与恢复"
    >
      <p class="mb-2 line-clamp-2 text-xs leading-relaxed opacity-70" role="status">
        {#if busy}
          正在检查目录更新…
        {:else if backend.error}
          {backend.error}
        {:else if backend.manifest}
          目录已加载（{monthCount} 个可用月份）
        {:else}
          目录尚未加载
        {/if}
      </p>
      <div class="flex flex-col items-stretch gap-2">
        <button
          class="rounded-full border border-accent bg-accent px-3 py-1 text-sm text-base-100 transition hover:opacity-90"
          onclick={refreshData}
        >
          {busy ? '重新发起刷新' : '刷新数据'}
        </button>
        {#if !confirmReload}
          <button
            class="rounded-full border border-base-300 px-3 py-1 text-sm transition hover:bg-base-200"
            onclick={() => (confirmReload = true)}
          >
            重新载入页面
          </button>
        {:else}
          <p class="text-xs leading-relaxed text-warning">重新载入会中断当前播放，确定吗？</p>
          <div class="flex gap-2">
            <button
              class="flex-1 rounded-full border border-warning px-3 py-1 text-sm transition hover:bg-base-200"
              onclick={reloadNow}
            >
              确认重载
            </button>
            <button
              class="flex-1 rounded-full border border-base-300 px-3 py-1 text-sm opacity-70 transition hover:opacity-100"
              onclick={() => (confirmReload = false)}
            >
              取消
            </button>
          </div>
        {/if}
      </div>
      <p class="mt-2 text-2xs leading-snug opacity-50">
        页面卡住时优先用「刷新数据」，不会打断播放；「重新载入」会重启整个页面。
      </p>
    </div>
  {/if}
</div>
