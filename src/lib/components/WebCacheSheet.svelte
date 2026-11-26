<script lang="ts">
  import { onMount } from 'svelte';
  import { HardDrive, Trash2, Download, CircleCheck, CircleDashed } from 'lucide-svelte';
  import { browser } from '$app/environment';
  import Sheet from './Sheet.svelte';
  import { clearOfflineCatalog } from '$lib/backend.svelte';
  import { player } from '$lib/player.svelte.ts';
  import { audioUrl } from '$lib/types';
  import { formatBytes } from '$lib/native-cache';
  import {
    DEFAULT_WEB_AUDIO_MAX_BYTES,
    clearWebAudioCache,
    getWebAudioEntryState,
    getWebAudioCacheLimit,
    getWebCacheStats,
    setWebAudioCacheLimit,
    subscribeWebCacheEvents,
    webCacheAvailable,
    type WebAudioEntryState,
    type WebCacheStats,
  } from '$lib/web-audio-cache';

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  // 只展示四档预设；WEB_AUDIO_MIN_BYTES…WEB_AUDIO_MAX_LIMIT 的夹取范围是存储层实现细节，
  // 由 setWebAudioCacheLimit 保证，不作为用户文案展示。
  const LIMIT_CHOICES = [
    { label: '256 MB', value: 256 * 1024 * 1024 },
    { label: '512 MB', value: DEFAULT_WEB_AUDIO_MAX_BYTES },
    { label: '1 GB', value: 1024 * 1024 * 1024 },
    { label: '2 GB', value: 2 * 1024 * 1024 * 1024 },
  ];

  const supported = browser && webCacheAvailable();
  let stats = $state<WebCacheStats | null>(null);
  let limit = $state(DEFAULT_WEB_AUDIO_MAX_BYTES);
  let busy = $state(false);
  let notice = $state<string | null>(null);
  let trackState = $state<WebAudioEntryState>('none');
  let recentCached = $state<string | null>(null); // 刚完成缓存的曲名提示

  async function refresh() {
    if (!browser) return;
    stats = await getWebCacheStats();
    limit = getWebAudioCacheLimit();
    await refreshTrackState();
  }

  function trackStableUrl(): string | null {
    const t = player.track;
    if (!t) return null;
    try {
      return audioUrl(t.audio.opus).split('?')[0] ?? null;
    } catch {
      return null;
    }
  }

  async function refreshTrackState() {
    const url = trackStableUrl();
    trackState = url ? await getWebAudioEntryState(url) : 'none';
  }

  onMount(() => {
    void refresh();
    return subscribeWebCacheEvents((event) => {
      void refresh();
      if (event.type === 'cached') {
        const url = trackStableUrl();
        if (url && new URL(event.stableUrl, location.href).href === new URL(url, location.href).href) {
          recentCached = player.track?.audio.title || '本曲';
        }
      }
    });
  });

  $effect(() => {
    if (open) void refresh();
  });

  // 切曲即刷新本曲状态；后台缓存完成事件已在订阅里触发 refresh。
  $effect(() => {
    void player.track?.audio.opus;
    recentCached = null;
    void refreshTrackState();
  });

  async function applyLimit(bytes: number) {
    if (busy) return;
    busy = true;
    limit = setWebAudioCacheLimit(bytes);
    notice = `上限已设为 ${formatBytes(limit)}`;
    await refresh();
    busy = false;
  }

  async function clearAll() {
    if (busy) return;
    busy = true;
    const result = await clearWebAudioCache();
    notice = `已清除 ${formatBytes(result.freedBytes)}（${result.entries} 项）；正在播放的一遍内仍可用`;
    recentCached = null;
    await refresh();
    busy = false;
  }

  async function clearCatalog() {
    if(busy)return;busy=true;
    try{await clearOfflineCatalog('all');notice='已清除离线目录快照（当前浏览内容保留）';}
    catch{notice='目录快照清理失败，请重试';}
    finally{busy=false;}
  }

  const pct = $derived(stats && stats.maxBytes > 0 ? Math.min(100, Math.round((stats.bytes / stats.maxBytes) * 100)) : 0);
</script>

<Sheet side="right" title="网页离线缓存" {open} {onClose}>
  <div class="flex flex-col gap-3 px-4 py-4 text-xs leading-relaxed">
    <p class="opacity-70">
      当前曲目播放时会在后台完整下载一次，完成即标记「可离线」；之后离线重开网页可直接播放。只缓存下载完整的音频，听一半不算已缓存。
    </p>

    {#if !supported}
      <p class="rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-warning">
        当前浏览器环境不支持本页面的离线音频缓存（需 HTTPS 或 localhost 的普通浏览环境）。播放不受影响，按在线方式进行。
      </p>
    {:else}
      <div class="rounded-lg border border-base-300 px-3 py-2">
        <div class="flex items-center gap-2">
          <HardDrive class="h-4 w-4 opacity-70" />
          <span class="font-medium">音频占用</span>
          <span class="ml-auto tabular-nums">{formatBytes(stats?.bytes ?? 0)} / {formatBytes(stats?.maxBytes ?? limit)}</span>
        </div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-base-200">
          <div class="h-full rounded-full bg-accent transition-all" style:width="{pct}%"></div>
        </div>
        <p class="mt-1 text-2xs opacity-60">
          {stats?.entries ?? 0} 首完整缓存{#if (stats?.downloading ?? 0) > 0} · {stats?.downloading} 首下载中{/if} · 超出上限按最久未使用淘汰
        </p>
      </div>

      {#if player.track}
        <div class="flex items-center gap-2 rounded-lg border border-base-300 px-3 py-2">
          {#if trackState === 'cached'}
            <CircleCheck class="h-4 w-4 shrink-0 text-accent" />
            <span class="min-w-0 flex-1 truncate">本曲可离线播放（{player.track.audio.title || '（未识别）'}）</span>
          {:else if trackState === 'downloading'}
            <Download class="h-4 w-4 shrink-0 animate-pulse text-accent" />
            <span class="min-w-0 flex-1 truncate">本曲离线缓存下载中…完成后自动生效</span>
          {:else}
            <CircleDashed class="h-4 w-4 shrink-0 opacity-50" />
            <span class="min-w-0 flex-1 truncate">本曲尚未缓存{trackState === 'none' ? '，开始播放后自动下载完整版' : ''}</span>
          {/if}
        </div>
      {/if}

      {#if recentCached}
        <p class="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-accent" role="status">
          「{recentCached}」已完整缓存，现在离线也能播。
        </p>
      {/if}

      <div>
        <p class="mb-1 font-medium">容量上限</p>
        <div class="grid grid-cols-4 gap-1">
          {#each LIMIT_CHOICES as choice (choice.value)}
            <button
              class="rounded-md border px-2 py-1 tabular-nums transition {limit === choice.value
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
          默认与 App 一致（512 MB）。
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="flex items-center gap-1 rounded-full border border-warning px-3 py-1 text-warning transition hover:bg-warning/10"
          disabled={busy}
          onclick={clearAll}
        >
          <Trash2 class="h-3.5 w-3.5" /> 清除音频缓存
        </button>
        <button class="rounded-full border border-base-300 px-3 py-1" disabled={busy} onclick={clearCatalog}>清除离线目录</button>
      </div>

      {#if notice}
        <p class="opacity-70" role="status">{notice}</p>
      {/if}

      <p class="text-2xs leading-relaxed opacity-50">
        浏览器可能因磁盘空间或隐私设置在网站不知情时清掉这些缓存；隐身模式的缓存随窗口关闭消失。
        离线重新打开网页依赖浏览器的离线页面版本：需先正常联网访问过一次本站。只有完整缓存的音频才能离线播放。
      </p>
    {/if}
  </div>
</Sheet>
