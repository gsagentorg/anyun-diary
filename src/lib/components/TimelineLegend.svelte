<script lang="ts">
import {lstarForRange,lstarToRgb} from '../lane-scale';
import {theme} from '../theme.svelte.ts';
let {laneMode='compress'}:{laneMode?:'linear'|'compress'}=$props();
const grayL=(c:number)=>theme.resolved==='dark'?lstarForRange(c,1,256,72,13):lstarForRange(c,1,256);
  // 固定对数域 [1,256]：整体缩放不影响 c；端点复用图表同一 grayL，方向跟随主题（owner 10:13 定）
  const LGT_MAX = 256;
  const lgStart = $derived(lstarToRgb(grayL(1)));
  const lgEnd = $derived(lstarToRgb(grayL(LGT_MAX)));
  const legendGray = $derived({
    css:
      'linear-gradient(to right, rgb(' + lgStart[0] + ', ' + lgStart[1] + ', ' + lgStart[2] + '), rgb(' +
      lgEnd[0] + ', ' + lgEnd[1] + ', ' + lgEnd[2] + '))',
  });
</script>
  <div data-timeline-legend aria-label="泳道图例" class="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-xs">
    <span class="flex items-center gap-1"><span class="h-3 w-3 rounded-sm bg-accent"></span> 歌（点击播放）</span>
    {#if laneMode === 'compress'}
<span class="flex flex-wrap items-center gap-1">
          <span class="text-2xs opacity-60 tabular-nums">×1（同歌速）</span>
          <span class="h-3 w-16 rounded-sm" style="background:{legendGray.css}"></span>
          <span class="text-2xs opacity-60 tabular-nums">×256</span>
          空白压缩倍数（相对歌的线性刻度，越深压得越狠）
        </span>
    {/if}
  </div>
