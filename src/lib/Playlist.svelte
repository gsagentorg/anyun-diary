<script lang="ts">
  import type { Recording } from './types';
  import { player, adopt } from './player.svelte';
  import { tracksInRange, dayStartOf, validRange } from './playlist-core';
  import { onMount } from 'svelte';
  import { fmtDur, fmtOffset, fmtDay, hueOf } from './types';
  import { Play, Download, Link, ExternalLink, ListMusic, Search, X } from 'lucide-svelte';

  let { recordings, open = $bindable(false) }: { recordings: Recording[]; open?: boolean } = $props();

  let from = $state('');
  let to = $state('');
  let error = $state('');
  let copied = $state(false);

  // 从 URL 查询参数预填，保证「外部播放器」链接带上同一范围
  onMount(() => {
    const sp = new URLSearchParams(location.search);
    if (!from) from = sp.get('from') ?? '';
    if (!to) to = sp.get('to') ?? '';
  });

  // 应用时把范围写回 URL（可分享/刷新保持）
  function syncUrl() {
    const sp = new URLSearchParams(location.search);
    if (from) sp.set('from', from); else sp.delete('from');
    if (to) sp.set('to', to); else sp.delete('to');
    history.replaceState(null, '', '?' + sp.toString());
  }

  // 服务端 m3u 端点：inline 交给系统播放器（VLC）打开，而非强制下载
  const apiPath = $derived(`/api/playlist?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

  const list = $derived(player.playlist);
  const total = $derived.by(() =>
    list.reduce((a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart), 0),
  );

  function label(): string {
    if (!from && !to) return '全部';
    if (!validRange(from, to)) return '（无效范围）';
    const a = fmtDay(dayStartOf(from)!);
    const b = (dayStartOf(to)! + 86400 - 1) * 1000;
    return a === fmtDay(b / 1000) ? a : `${from} → ${to}`;
  }

  function collect(): { tracks: ReturnType<typeof tracksInRange>; ok: boolean } {
    const lo = from ? dayStartOf(from) : null;
    const hi = to ? dayStartOf(to)! + 86400 : null;
    if (from && to && !validRange(from, to)) return { tracks: [], ok: false };
    const tracks = tracksInRange(recordings, lo ?? undefined, hi ?? undefined);
    return { tracks, ok: tracks.length > 0 };
  }

  function playInternal() {
    const { tracks, ok } = collect();
    if (!ok) {
      error = '范围内没有切片';
      return;
    }
    error = '';
    syncUrl();
    adopt(tracks, 0);
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
      动态播放列表
      {#if list.length > 0}
        <span class="rounded-full bg-accent/15 px-2 text-[10px] tabular-nums opacity-80">
          {list.length} 首 · {fmtDur(total)}
        </span>
      {/if}
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
      onclick={playInternal}
    >
      <Search class="h-3 w-3" /> 应用并播放
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
      href={apiPath}
      download="anyun-diary.m3u"
      title="保存为 .m3u 文件"
    >
      <Download class="h-3 w-3" /> 下载
    </a>
    {#if error}
      <span class="text-warning">{error}</span>
    {/if}
  </div>

  {#if list.length > 0}
    <ol class="mt-3 max-h-72 space-y-1 overflow-y-auto border-t pt-3 text-xs">
      {#each list as t, i (t.clip.file)}
        {@const hue = hueOf(t.clip.title)}
        <li>
          <button
            class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition hover:bg-base-200 {i === player.pos ? 'bg-accent/15' : ''}"
            onclick={() => {
              player.pos = i;
              adopt(list, i);
            }}
          >
            {#if i === player.pos}
              <Play class="h-3 w-3 shrink-0 text-accent" />
            {:else}
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hue} 70% 60%)"></span>
            {/if}
            <span class="w-14 shrink-0 text-[10px] opacity-50">{fmtDay(t.rec.start).slice(5, 11)}</span>
            <span class="w-10 shrink-0 text-[10px] opacity-50">{fmtOffset(t.clip.offsetStart)}</span>
            <span class="truncate font-medium">{t.clip.title || '（未识别）'}</span>
            <span class="shrink-0 text-[10px] opacity-50">{fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</div>
