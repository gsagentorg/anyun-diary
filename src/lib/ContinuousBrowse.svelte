<script lang="ts">
import TimelineLegend from './components/TimelineLegend.svelte';
import BrowseSkeleton from './components/BrowseSkeleton.svelte';
import {onMount} from 'svelte';
import {backend} from './backend.svelte';
import {shDayStart} from './playlist-core';
import type {Audio} from './types';


let {view,laneMode,startAt,endAt,expanded=$bindable<number|null>(null),pending=[],onretry}:{view:number;laneMode:'linear'|'compress';startAt:number;endAt:number;expanded?:number|null;pending?:{id:string;error:string|null}[];onretry?:(id:string)=>void}=$props();
let host:HTMLElement,scroll=$state(0),viewport=$state(900),columns=$state(3),origin=$state(0);
const all=$derived(Object.values(backend.summaries).flat().filter(a=>a.startAt>=startAt&&a.startAt<endAt));
const days=$derived.by(()=>{const map=new Map<number,Audio[]>();for(const a of all){const day=shDayStart(a.startAt);const list=map.get(day)??[];list.push(a);map.set(day,list);}return [...map].sort(([a],[b])=>b-a);});
const rowSize=$derived(view===0?(laneMode==='linear'?48:56):82);
const perRow=$derived(view===0?1:columns);
const rowCount=$derived(Math.ceil(days.length/perRow));
const heights=$state<Record<string,number>>({});
const offsets=$derived.by(()=>{const out=[0];for(let i=0;i<rowCount;i++){const key=view+":"+perRow+":"+days[i*perRow]?.[0];out.push(out.at(-1)!+(heights[key]??rowSize));}return out;});
function rowAt(y:number){const found=offsets.findIndex(v=>v>y);return found<0?rowCount:Math.max(0,found-1);}
const first=$derived(Math.max(0,rowAt(scroll-origin)-8));
const last=$derived(Math.min(rowCount,Math.max(first+1,rowAt(scroll-origin+viewport)+9)));
const windowDays=$derived(days.slice(first*perRow,last*perRow));
// Rendering needs only lightweight summaries. Playback entry points resolve full lyrics on demand.
const windowAudios=$derived(windowDays.flatMap(([,audios])=>audios));
onMount(()=>{const update=()=>{scroll=window.scrollY;viewport=innerHeight;columns=innerWidth>=1280?3:innerWidth>=640?2:1;origin=host.getBoundingClientRect().top+scroll;};update();window.addEventListener('scroll',update,{passive:true});window.addEventListener('resize',update);const resize=new ResizeObserver(()=>{update();if(view===1){const cards=[...host.querySelectorAll<HTMLElement>('[data-day]')];for(let i=0;i<cards.length;i+=columns){const row=cards.slice(i,i+columns),height=Math.max(...row.map(el=>el.getBoundingClientRect().height))+16;const key=view+":"+columns+":"+row[0]?.dataset.day;if(Math.abs((heights[key]??82)-height)>1)heights[key]=height;}}});resize.observe(host);return()=>{resize.disconnect();window.removeEventListener('scroll',update);window.removeEventListener('resize',update);};});
</script>
<div bind:this={host} data-continuous-browse data-day-count={days.length} data-cached-months={Object.keys(backend.months).length}>
<div style:height={offsets[Math.min(first,rowCount)]+'px'} aria-hidden="true"></div>
{#if view===0}{#await import('./Timeline.svelte') then module}<module.default audios={windowAudios} {laneMode}/>{/await}
{:else}{#await import('./DayStrip.svelte') then module}<module.default audios={windowAudios} bind:expanded/>{/await}{/if}
<div style:height={Math.max(0,offsets[rowCount]-(offsets[last]??0))+'px'} aria-hidden="true"></div>
<!-- 未就绪月份跟在已加载数据之后、图例之前：占位块属于同一段流，标签与骨架条同一行 -->
{#each pending as ref (ref.id)}
{#if ref.error}<p role="alert" class="mb-2 text-xs text-warning">{ref.error} <button onclick={()=>onretry?.(ref.id)}>重试此月</button></p>
{:else}<BrowseSkeleton label={'正在加载 '+ref.id+'…'} caption={view===0?ref.id:''} height={laneMode==='linear'?'h-10':'h-12'}/>{/if}
{/each}
{#if view===0}<TimelineLegend {laneMode}/>{/if}

</div>
