<script lang="ts">
  // caption 非空 = 泳道式占位：左侧时间（月份）标签 + 右侧一行歌曲块状骨架，跟已加载泳道同一列栅格。
  // caption 为空 = 整页/网格占位（首屏目录、热力图），保持原来整块堆叠版式。
  let { label = '正在加载目录…', caption = '', height = 'h-12' }: { label?: string; caption?: string; height?: string } = $props();
  // 与已加载泳道对齐：linear 泳道 h-10 内 song 块 top-2.5（10px），compress 泳道 h-12 内 top-6（24px）。
  const blockTop = $derived(height === 'h-12' ? '24px' : '10px');
  // 一行疏密不一的「歌块」：宽度、间隔都不均，跟加载完成后真实歌块的排布同构。
  const blocks = [13, 6, 19, 7, 11, 5];
</script>
{#if caption}
  <div role="status" aria-label={label} data-browse-skeleton data-browse-skeleton-lane class="mb-2 flex {height} items-stretch">
    <div class="flex w-24 shrink-0 flex-col justify-center gap-0.5 pr-2" data-browse-skeleton-label>
      <span class="truncate text-sm font-bold tabular-nums opacity-60">{caption}</span>
      <span class="truncate text-2xs opacity-60">加载中…</span>
    </div>
    <div class="min-w-0 flex-1 overflow-hidden" data-browse-skeleton-bars>
      <div class="flex gap-2" style:padding-top={blockTop} data-browse-skeleton-row>
        {#each blocks as width}<div data-browse-skeleton-block class="h-5 shrink-0 animate-pulse rounded-sm bg-base-300/60" style:width={width + '%'}></div>{/each}
      </div>
    </div>
  </div>
{:else}
  <div role="status" aria-label={label} class="min-h-[180px] space-y-3 py-3" data-browse-skeleton><p class="text-xs opacity-60">{label}</p>{#each Array(3) as _}<div class="h-10 animate-pulse rounded bg-base-300/40"></div>{/each}</div>
{/if}
