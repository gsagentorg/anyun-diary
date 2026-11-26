<script lang="ts">
  // caption 非空 = 泳道式占位：左侧时间（月份）标签 + 右侧骨架条同处一行，跟已加载泳道同一列栅格。
  // caption 为空 = 整页/网格占位（首屏目录、热力图），保持原来整块堆叠版式。
  let { label = '正在加载目录…', caption = '', height = 'h-12' }: { label?: string; caption?: string; height?: string } = $props();
</script>
{#if caption}
  <div role="status" aria-label={label} data-browse-skeleton data-browse-skeleton-lane class="mb-2 flex {height} items-stretch">
    <div class="flex w-24 shrink-0 flex-col justify-center gap-0.5 pr-2" data-browse-skeleton-label>
      <span class="truncate text-sm font-bold tabular-nums opacity-60">{caption}</span>
      <span class="truncate text-2xs opacity-60">加载中…</span>
    </div>
    <div class="min-w-0 flex-1 py-1.5 space-y-1.5" data-browse-skeleton-bars>
      {#each [92, 64, 82] as width}<div class="h-2 animate-pulse rounded bg-base-300/40" style:width={width + '%'}></div>{/each}
    </div>
  </div>
{:else}
  <div role="status" aria-label={label} class="min-h-[180px] space-y-3 py-3" data-browse-skeleton><p class="text-xs opacity-60">{label}</p>{#each Array(3) as _}<div class="h-10 animate-pulse rounded bg-base-300/40"></div>{/each}</div>
{/if}
