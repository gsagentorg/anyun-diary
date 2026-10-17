<script lang="ts">
  import { Inbox, Database } from 'lucide-svelte';

  let { kind }: { kind: 'empty' | 'no-data' | 'loading' } = $props();

  const label = $derived(kind === 'empty' ? '暂无内容' : kind === 'no-data' ? '无数据' : '');
</script>

<div class="flex items-center justify-center py-8 text-center" role="status" aria-live="polite">
  {#if kind === 'loading'}
    <span class="flex items-center gap-1.5" aria-label="加载中">
      <span class="h-2 w-2 animate-bounce rounded-full bg-current opacity-40" style:animation-delay="-0.3s"></span>
      <span class="h-2 w-2 animate-bounce rounded-full bg-current opacity-40" style:animation-delay="-0.15s"></span>
      <span class="h-2 w-2 animate-bounce rounded-full bg-current opacity-40"></span>
    </span>
  {:else}
    <span class="inline-flex items-center gap-2 text-sm opacity-60">
      {#if kind === 'empty'}
        <Inbox class="h-5 w-5 opacity-40" />
      {:else}
        <Database class="h-5 w-5 opacity-40" />
      {/if}
      {label}
    </span>
  {/if}
</div>
