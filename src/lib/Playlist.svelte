<script lang="ts">
import { onDestroy } from 'svelte';import {audiosInRange,backend} from './backend.svelte';import {prependTracks} from './player.svelte.ts';import type {Audio,Track} from './types';
let {open=$bindable(false),from=$bindable(''),to=$bindable('')}:{open?:boolean;from?:string;to?:string}=$props();
import {createLatestOperation} from './interactions.js';
const operation=createLatestOperation();
let busy=$state(false),error=$state(''),result=$state<Audio[]>([]);let controller:AbortController|undefined;
function cancel(){controller?.abort();operation.cancel();busy=false;}onDestroy(cancel);
$effect(()=>{void from;void to;void backend.generation;void open;cancel();result=[];error='';});
async function generate(){cancel();const c=new AbortController();controller=c;busy=true;error='';try{if(!from||!to)throw Error('请选择完整日期范围');const lo=Date.parse(from+'T00:00:00+08:00')/1000,hi=Date.parse(to+'T00:00:00+08:00')/1000+86400;await operation.run(async(signal:AbortSignal)=>{const audios=await audiosInRange(lo,hi,signal);if(!audios.length)throw Error('范围内没有音频');return audios;},(audios:Audio[])=>{result=audios;const tracks:Track[]=audios.map(audio=>({queueEntryId:crypto.randomUUID(),audio}));prependTracks(tracks);});}catch(e){if(!c.signal.aborted)error=e instanceof Error?e.message:'生成失败';}finally{if(controller===c)busy=false;}}
</script>
<section class="rounded-xl border border-base-300 p-4"><div class="flex justify-between"><h2>按日期生成播放列表</h2><button onclick={()=>open=false}>收起</button></div><div class="my-3 flex flex-wrap gap-2"><input aria-label="开始日期" type="date" bind:value={from}/><span>至</span><input aria-label="结束日期" type="date" bind:value={to}/><button disabled={busy} onclick={generate}>完整加载并插入队首播放</button>{#if busy}<button onclick={cancel}>取消</button>{/if}</div>{#if busy}<p role="status">正在按月加载，完成前不会修改队列…</p>{/if}{#if error}<p role="alert">{error}（原队列未修改）</p>{/if}{#if result.length}<p>已插入 {result.length} 首</p>{/if}</section>
