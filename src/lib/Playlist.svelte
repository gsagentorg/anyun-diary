<script lang="ts">
  import type { Recording, Track } from './types';
  import { player, insertRange } from './player.svelte';
  import { tracksInRange, dayStartOf, validRange } from './playlist-core';
  import { onMount } from 'svelte';
  import { fmtDur } from './types';
  import { Download, Link, ExternalLink, ListMusic, Search, X, Play } from 'lucide-svelte';

  let { recordings, open = $bindable(false) }: { recordings: Recording[]; open?: boolean } = $props();

  let from = $state('');
  let to = $state('');
  let error = $state('');
  let copied = $state(false);

  // 从 URL 查询参数预填，保证「外部播放器」链接带上同一范围
  let origin = $state('');
  onMount(() => {
    const sp = new URLSearchParams(location.search);
    if (!from) from = sp.get('from') ?? '';
    if (!to) to = sp.get('to') ?? '';
    origin = location.origin; // 歌单里的音频地址按当前页面协议生成（https 场景必需）
  });

  // 应用时把范围写回 URL（可分享/刷新保持）
  function syncUrl() {
    const sp = new URLSearchParams(location.search);
    if (from) sp.set('from', from); else sp.delete('from');
    if (to) sp.set('to', to); else sp.delete('to');
    history.replaceState(null, '', '?' + sp.toString());
  }

  // 服务端歌单端点：默认 m3u（外部播放器兼容面最广），xspf/pls 可选；inline 交给系统播放器
  let fmt = $state<'xspf' | 'pls' | 'm3u'>('m3u');
  const apiPath = $derived(
    `/api/playlist?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=${fmt}` +
      (origin ? `&base=${encodeURIComponent(origin)}` : ''),
  );

  // 范围预览：from/to 变化时展示 tracksInRange 结果（不再绑定播放队列）
  const preview = $derived.by(() => {
    if (from && to && !validRange(from, to)) return { tracks: [] as Track[], ok: false };
    const lo = from ? dayStartOf(from) : null;
    const hi = to ? dayStartOf(to)! + 86400 : null;
    const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
    return { tracks, ok: tracks.length > 0 };
  });
  const previewTotal = $derived(preview.tracks.reduce(
    (a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart),
    0,
  ));
  const previewTop = $derived(preview.tracks.slice(0, 20));
  const previewRest = $derived(Math.max(0, preview.tracks.length - 20));

  function generate() {
    if (from && to && !validRange(from, to)) {
      error = '范围无效';
      return;
    }
    error = '';
    syncUrl();
    const n = insertRange(preview.tracks);
    if (n === 0) error = '范围内没有切片';
  }

  function playExternal() {
    // 直接打开（新标签）：浏览器若注册了 m3u 处理器（VLC）会交给它，否则才下载
    if (from && to && !validRange(from, to)) {
      error = '范围无效';
      return;
    }
    error = '';
    window.open(apiPath, '_blank', 'noopener');
  }

  function openVlc() {
    if (from && to && !validRange(from, to)) {
      error = '范围无效';
      return;
    }
    error = '';
    const abs = new URL(apiPath, location.origin).toString();
    // vlc:// 由系统上的 VLC 协议处理器接管（Windows/macOS 通常已注册）
    location.href = 'vlc://' + abs;
  }

  async function copyLink() {
    const abs = new URL(apiPath, location.origin).toString();
    try {
      await navigator.clipboard.writeText(abs);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      error = '复制失败，请手动复制：' + abs;
    }
  }
</script>

<div class="card rounded-xl border bg-base-100 p-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2 text-sm font-semibold">
      <ListMusic class="h-4 w-4" />
      按时间生成
    </div>
    <button class="rounded p-1 transition hover:bg-base-200" onclick={() => (open = false)} aria-label="收起">
      <X class="h-4 w-4" />
    </button>
  </div>

  <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
    <input type="date" bind:value={from} class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums" />
    <span class="opacity-50">→</span>
    <input type="date" bind:value={to} class="rounded border border-base-300 bg-base-200 px-2 py-1 tabular-nums" />
    <button
      class="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-accent-content transition hover:opacity-90"
      onclick={generate}
    >
      <Search class="h-3 w-3" /> 生成并插入队列
    </button>
    <a
      class="flex items-center gap-1 rounded border border-base-300 px-2.5 py-1 transition hover:bg-base-200"
      href={apiPath}
      target="_blank"
      rel="noopener"
      title="交给系统里注册的播放器（VLC 等）播放；未注册处理器时浏览器会下载"
    >
      <ExternalLink class="h-3 w-3" /> 外部播放器打开
    </a>
    <select
      bind:value={fmt}
      class="rounded border border-base-300 bg-base-200 px-1.5 py-1 text-xs"
      aria-label="歌单格式"
      title="xspf/pls 是逐曲歌单（不会被当成 HLS 分片）；m3u 兼容性最广"
    >
      <option value="m3u">.m3u 逐曲歌单</option>
      <option value="xspf">.xspf 逐曲歌单</option>
      <option value="pls">.pls 逐曲歌单</option>
    </select>
    <button
      class="flex items-center gap-1 rounded border border-base-300 px-2.5 py-1 transition hover:bg-base-200"
      onclick={openVlc}
      title="用 vlc:// 协议直接唤起本机 VLC"
    >
      <Play class="h-3 w-3" /> 直开 VLC
    </button>
    <button
      class="flex items-center gap-1 rounded border border-base-300 px-2.5 py-1 transition hover:bg-base-200"
      onclick={copyLink}
      title="复制 m3u 端点链接，可粘到 VLC/mpv 里"
    >
      {#if copied}<Link class="h-3 w-3 text-accent" /> 已复制{:else}<Link class="h-3 w-3" /> 复制链接{/if}
    </button>
    <a
      class="flex items-center gap-1 rounded border border-base-300 px-2.5 py-1 transition hover:bg-base-200"
      href={`${apiPath}&download=1`}
      download="anyun-diary-playlist"
      title="保存为歌单文件"
    >
      <Download class="h-3 w-3" /> 下载
    </a>
    {#if error}
      <span class="text-warning">{error}</span>
    {/if}
  </div>

  <div class="mt-3 border-t border-base-300 pt-3 text-xs">
    <span class="rounded-full bg-accent/15 px-2 py-0.5 text-2xs tabular-nums opacity-80">
      {preview.tracks.length} 首 · {fmtDur(previewTotal)}
    </span>
    {#if preview.ok}
      <ol class="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
        {#each previewTop as t, i (t.clip.file)}
          <li class="flex items-center gap-2 px-1 py-0.5 text-xs">
            <span class="w-7 shrink-0 text-2xs tabular-nums opacity-50">{i + 1}</span>
            <span class="truncate">{t.clip.title || '（未识别）'}</span>
            <span class="ml-auto shrink-0 text-2xs tabular-nums opacity-50">
              {fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}
            </span>
          </li>
        {/each}
        {#if previewRest > 0}
          <li class="px-1 py-0.5 text-2xs opacity-50">…其余 {previewRest} 首</li>
        {/if}
      </ol>
    {:else}
      <p class="mt-2 px-1 text-2xs opacity-50">范围内没有切片</p>
    {/if}
  </div>
</div>
