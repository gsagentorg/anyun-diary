<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { playClip } from '$lib/player.svelte.ts';
  import { searchClips, clipClock, type SearchHit } from '$lib/search';
  import { fmtDay } from '$lib/types';
  import type { Recording } from '$lib/types';

  let {
    open = $bindable(false),
    recordings,
  }: {
    open: boolean;
    recordings: Recording[];
  } = $props();

  let q = $state('');
  // 搜索自带的日期限定：独立于播放列表区间，默认空 = 搜全部
  let rangeFrom = $state('');
  let rangeTo = $state('');
  let hits = $state<SearchHit[]>([]);
  let debounce: ReturnType<typeof setTimeout> | undefined;

  // 输入防抖 150ms；范围变化也触发重搜
  $effect(() => {
    void q;
    void rangeFrom;
    void rangeTo;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      hits = searchClips(recordings, q, { from: rangeFrom || undefined, to: rangeTo || undefined });
    }, 150);
    return () => clearTimeout(debounce);
  });

  function pick(h: SearchHit) {
    playClip(h.rec, h.clipIndex);
    open = false;
  }
</script>

<Sheet open={open} onClose={() => (open = false)} side="right" title="搜索">
  <div class="flex h-full min-h-0 flex-col gap-2">
    <input
      type="search"
      placeholder="歌名 / 歌词 / time:16:00-17:00 / date:10-02"
      bind:value={q}
      class="w-full shrink-0 rounded-md border border-base-300 bg-base-100 px-2.5 py-1.5 text-sm outline-none transition focus:border-accent"
      aria-label="搜索关键词"
    />
    <div class="flex shrink-0 items-center gap-1.5 text-2xs">
      <span class="shrink-0 opacity-55">日期限定</span>
      <input
        type="date"
        bind:value={rangeFrom}
        class="min-w-0 flex-1 rounded-md border border-base-300 bg-base-100 px-1.5 py-1 outline-none transition focus:border-accent"
        aria-label="搜索起始日期"
      />
      <span class="shrink-0 opacity-40">–</span>
      <input
        type="date"
        bind:value={rangeTo}
        class="min-w-0 flex-1 rounded-md border border-base-300 bg-base-100 px-1.5 py-1 outline-none transition focus:border-accent"
        aria-label="搜索结束日期"
      />
      {#if rangeFrom || rangeTo}
        <button
          class="shrink-0 rounded-md px-1.5 py-1 hover:bg-base-200"
          onclick={() => { rangeFrom = ''; rangeTo = ''; }}
          title="清除日期限定"
        >✕</button>
      {/if}
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if q.trim() === ''}
        <div class="space-y-1 p-1 text-2xs leading-5 opacity-55">
          <p>直接输入关键词：歌名 / 歌词 / 日期 都能搜（如 <code>星星</code>、<code>10-02</code>）。</p>
          <p>
            高级：字段:值 ——
            <code>title:</code> 歌名 · <code>lyrics:</code> 歌词 ·
            <code>time:</code> HH:MM 或 HH:MM-HH:MM · <code>date:</code> MM-DD 或 YYYY-MM-DD
          </p>
          <p>多个条件用空格分隔 = 同时满足（AND）。日期限定独立于播放列表区间，不填 = 搜全部。</p>
        </div>
      {:else if hits.length === 0}
        <div class="p-1 text-sm opacity-50">无结果</div>
      {:else}
        <ul class="flex flex-col gap-0.5">
          {#each hits as h (h.clip.file + '@' + h.clipIndex)}
            {@const cc = clipClock(h.rec, h.clip)}
            <li>
              <button
                class="w-full rounded-md px-2 py-1.5 text-left transition hover:bg-base-200"
                onclick={() => pick(h)}
                title="插入队列并播放"
              >
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 truncate text-sm font-medium">{h.clip.title || '（未识别）'}</span>
                  <span class="ml-auto shrink-0 text-2xs tabular-nums opacity-50">{fmtDay(h.rec.start)} {cc.hm}</span>
                </div>
                {#if h.line}
                  <div class="truncate text-2xs opacity-60">{h.line}</div>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
        {#if hits.length >= 100}
          <div class="p-1 text-2xs opacity-40">结果过多，只显示前 100 条，请细化条件</div>
        {/if}
      {/if}
    </div>
  </div>
</Sheet>
