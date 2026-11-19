<script lang="ts">let {label='正在加载目录…'}:{label?:string}=$props();</script>
<div role="status" aria-label={label} class="min-h-[180px] space-y-3 py-3" data-browse-skeleton><p class="text-xs opacity-60">{label}</p>{#each Array(3) as _}<div class="h-10 animate-pulse rounded bg-base-300/40"></div>{/each}</div>
