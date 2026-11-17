<script lang="ts">
import {onMount} from 'svelte';
import {backend,loadMonth,pinMonth,type MonthRef} from './backend.svelte';
let {ref,view,laneMode,startAt,endAt,heatFrom,heatTo,expanded=$bindable<number|null>(null)}:{ref:MonthRef;view:number;laneMode:'linear'|'compress';startAt:number;endAt:number;heatFrom:string;heatTo:string;expanded?:number|null}=$props();
let host:HTMLElement;let active=$state(false),height=$state(180);
const audios=$derived((backend.months[ref.id]??[]).filter(a=>a.startAt>=startAt&&a.startAt<endAt));
onMount(()=>{let release:(()=>void)|undefined;const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){release??=pinMonth(ref.id);active=true;if(!backend.months[ref.id]&&!backend.loading[ref.id]&&!backend.errors[ref.id])void loadMonth(ref.id).catch(()=>{});}else{height=Math.max(180,host.getBoundingClientRect().height);active=false;release?.();release=undefined;}}},{rootMargin:'800px 0px'});observer.observe(host);return()=>{observer.disconnect();release?.();};});
</script>
<section bind:this={host} data-month={ref.id} style:min-height={!active?height+'px':undefined}>
{#if active}
{#if backend.errors[ref.id]}<p role="alert">{backend.errors[ref.id]} <button onclick={()=>void loadMonth(ref.id).catch(()=>{})}>重试此月</button></p>
{:else if !backend.months[ref.id]}<p role="status">正在加载 {ref.id}…</p>
{:else if view===0}{#await import('./Timeline.svelte') then m}<m.default {audios} {laneMode}/>{/await}
{:else if view===1}{#await import('./DayStrip.svelte') then m}<m.default {audios} bind:expanded/>{/await}
{:else}{#await import('./Heatmap.svelte') then m}<m.default {audios} gridOnly from={heatFrom} to={heatTo}/>{/await}{/if}
{/if}
</section>
