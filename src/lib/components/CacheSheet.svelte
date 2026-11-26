<script lang="ts">
  import { onMount } from 'svelte';
  import { HardDrive, Trash2 } from 'lucide-svelte';
  import Sheet from './Sheet.svelte';
  import { clearOfflineCatalog } from '$lib/backend.svelte';
  import {
    CACHE_POLICY_LIMITS,
    DEFAULT_CACHE_POLICY,
    type CachePolicy,
    type CacheScope,
    type CacheStats,
    type NativeCacheApi,
    clearNativeCache,
    clampCachePolicy,
    formatBytes,
    nativeCacheApi,
    nativeCacheAvailable,
    nativeCacheStats,
    setNativeCachePolicy,
  } from '$lib/native-cache';

  // api 可注入：默认取原生桥；注入只用于在浏览器里预览/测试本面板。
  let { open, onClose, api = nativeCacheApi() }: { open: boolean; onClose: () => void; api?: NativeCacheApi | null } = $props();

  const LIMIT_CHOICES = [
    { label: '256 MB', value: 256 * 1024 * 1024 },
    { label: '512 MB', value: DEFAULT_CACHE_POLICY.maxBytes },
    { label: '1 GB', value: 1024 * 1024 * 1024 },
    { label: '2 GB', value: 2 * 1024 * 1024 * 1024 },
  ];

  let stats = $state<CacheStats | null>(null);
  let policy = $state<CachePolicy>(DEFAULT_CACHE_POLICY);
  let busy = $state(false);
  let notice = $state<string | null>(null);
  const supported = $derived(api != null || nativeCacheAvailable());

  /** 只在面板打开时读一次；其余动作后刷新。 */
  async function refresh() {
    if (!supported) return;
    const next = await nativeCacheStats(api);
    if (next) {
      stats = next;
      policy = clampCachePolicy({ maxBytes: next.maxBytes }, policy);
    }
  }

  onMount(() => {
    void refresh();
  });

  $effect(() => {
    if (open) void refresh();
  });

  async function clear(scope: CacheScope) {
    if (busy) return;
    busy = true;
    if(scope!=='media')await clearOfflineCatalog('all');
    const result = await clearNativeCache(scope, api);
    busy = false;
    notice = result ? `已清理 ${formatBytes(result.freedBytes)}（${result.entries} 项）` : '清理失败：原生接口未响应';
    await refresh();
  }

  async function applyLimit(bytes: number) {
    if (busy) return;
    busy = true;
    const next = await setNativeCachePolicy({ maxBytes: bytes }, api);
    busy = false;
    notice = next ? `上限已设为 ${formatBytes(next.maxBytes)}` : '调整失败：原生接口未响应';
    await refresh();
  }
</script>

<Sheet side="right" title="本地缓存" {open} {onClose}>
  <div class="flex flex-col gap-3 px-4 py-4 text-xs leading-relaxed">
    <p class="opacity-70">
      音频与索引缓存在 App 原生层：命中缓存立即播放，后台再校验更新；音频视为不可变，索引校验更频繁。
      网页另有独立的离线缓存。离线目录快照最多保留三个已加载月份，清除索引也会清除这些快照。
    </p>
    {#if !supported}
      <p class="rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-warning">
        当前不在 App 原生壳内，或不支持原生缓存。网页端由浏览器 HTTP 缓存自行处理。
      </p>
    {:else}
      <div class="rounded-lg border border-base-300 px-3 py-2">
        <div class="flex items-center gap-2">
          <HardDrive class="h-4 w-4 opacity-70" />
          <span class="font-medium">占用</span>
          <span class="ml-auto tabular-nums">{formatBytes(stats?.bytes ?? 0)} / {formatBytes(stats?.maxBytes ?? policy.maxBytes)}</span>
        </div>
        <p class="mt-1 text-2xs opacity-60">
          音频 {stats?.mediaEntries ?? 0} 项 · 索引 {stats?.jsonEntries ?? 0} 项 · 共 {stats?.entries ?? 0} 项
          {#if stats?.cacheDir}<br /><span class="break-all">{stats.cacheDir}</span>{/if}
        </p>
      </div>

      <div>
        <p class="mb-1 font-medium">容量上限</p>
        <div class="grid grid-cols-4 gap-1">
          {#each LIMIT_CHOICES as choice (choice.value)}
            <button
              class="rounded-md border px-2 py-1 tabular-nums transition {policy.maxBytes === choice.value
                ? 'border-accent text-accent'
                : 'border-base-300 hover:bg-base-200'}"
              disabled={busy}
              onclick={() => applyLimit(choice.value)}
            >
              {choice.label}
            </button>
          {/each}
        </div>
        <p class="mt-1 text-2xs opacity-50">
          超出上限时按最久未使用淘汰；范围 {formatBytes(CACHE_POLICY_LIMITS.maxBytes[0])}–{formatBytes(CACHE_POLICY_LIMITS.maxBytes[1])}。
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="flex items-center gap-1 rounded-full border border-warning px-3 py-1 text-warning transition hover:bg-warning/10"
          disabled={busy}
          onclick={() => clear('media')}
        >
          <Trash2 class="h-3.5 w-3.5" /> 清除音频缓存
        </button>
        <button
          class="rounded-full border border-base-300 px-3 py-1 transition hover:bg-base-200"
          disabled={busy}
          onclick={() => clear('json')}
        >
          清除索引缓存
        </button>
        <button
          class="rounded-full border border-warning px-3 py-1 text-warning transition hover:bg-warning/10"
          disabled={busy}
          onclick={() => clear('all')}
        >
          全部清除
        </button>
      </div>

      {#if notice}<p class="text-2xs text-accent" role="status">{notice}</p>{/if}
      <p class="text-2xs opacity-50">
        清除后已获租约的当前音频仍可继续播放；已清除内容下次需联网重新缓存。
      </p>
    {/if}
  </div>
</Sheet>