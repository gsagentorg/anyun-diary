<script lang="ts">
  import Sheet from './Sheet.svelte';
  import StateHint from './StateHint.svelte';
  import { player, playAt, removeAt, clearQueue } from '$lib/player.svelte';
  import { fmtDur } from '$lib/types';
  import { X } from 'lucide-svelte';

  const list = $derived(player.playlist);
  const total = $derived.by(() =>
    list.reduce((a, t) => a + (t.clip.offsetEnd - t.clip.offsetStart), 0),
  );
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
      {#each list as t, i (t.clip.file)}
        <li>
          <div
            class="flex items-center gap-1 rounded border-l-2 px-1 py-0.5 {i === player.pos
              ? 'border-accent bg-accent-muted'
              : 'border-transparent'}"
            aria-current={i === player.pos ? 'true' : undefined}
          >
            <button
              class="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition hover:bg-base-200"
              onclick={() => playAt(i)}
            >
              <span class="w-6 shrink-0 text-2xs tabular-nums opacity-50">{i + 1}</span>
              <span class="truncate font-medium">{t.clip.title || '（未识别）'}</span>
              <span class="ml-auto shrink-0 text-2xs tabular-nums opacity-50">
                {fmtDur(t.clip.offsetEnd - t.clip.offsetStart)}
              </span>
            </button>
            <button
              class="shrink-0 rounded p-1 transition hover:bg-base-200"
              onclick={() => removeAt(i)}
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
