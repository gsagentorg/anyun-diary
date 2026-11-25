<script lang="ts">
import Sheet from './Sheet.svelte';import type {Audio} from '$lib/types';import {playAudio} from '$lib/player.svelte.ts';import {backend,searchAudios} from '$lib/backend.svelte';
import {createLatestOperation} from '../interactions.js';
import {audioUrl} from '$lib/types';
import {createOfflineAvailability,offlineRowHint} from '$lib/offline-availability';
const availability=createOfflineAvailability();
$effect(()=>availability.setTargets(open?hits.map(hit=>audioUrl(hit.audio.opus)):[],backend.generation+':'+backend.base));
const operation=createLatestOperation();
let {open=$bindable(false)}:{open:boolean}=$props();let q=$state(''),hits=$state<{audio:Audio;line?:string}[]>([]),busy=$state(false),error=$state(''),completed=$state(0),total=$state(0),timedOut=$state(false);
$effect(()=>{const query=q.trim();void backend.generation;operation.cancel();hits=[];error='';completed=0;total=0;timedOut=false;busy=false;if(!open||!query)return;busy=true;const timer=setTimeout(()=>{void operation.run(async(signal:AbortSignal,guard:any)=>{try{await searchAudios(query,{signal,onMessage:guard((msg:any)=>{if(msg.type==='results')hits=[...hits,...msg.hits];if(msg.type==='progress'||msg.type==='done'){completed=msg.completed;total=msg.total;}if(msg.type==='done')timedOut=!!msg.timedOut;})});}catch(e){guard(()=>{error=e instanceof Error?e.message:'搜索失败';})();}finally{guard(()=>busy=false)();}},()=>{});},180);return()=>{clearTimeout(timer);operation.cancel();};});
</script>
<Sheet {open} onClose={()=>open=false} side="right" title="搜索"><div class="flex h-full flex-col gap-3"><input type="search" aria-label="搜索关键词" placeholder="歌名 / 歌词 / date: / time:" bind:value={q} class="rounded border p-2"/>{#if busy}<p role="status">搜索中，已完成 {completed}/{total} 月</p>{:else if q.trim()}<p>{error?'搜索未完成，保留已有结果':timedOut?'搜索超时，部分结果':completed<total?'搜索未完成，保留已有结果':'搜索完成'} · 完成 {completed}/{total} 月</p>{/if}{#if error}<p role="alert">{error}</p>{/if}<ul class="min-h-0 overflow-auto">{#each hits as hit,i (hit.audio.id+'-'+i)}{@const stableUrl=audioUrl(hit.audio.opus)}{@const offlineHint=offlineRowHint($availability,stableUrl)}<li><button class="w-full rounded p-2 text-left hover:bg-base-200" class:offline-missing={!$availability.online&&$availability.statuses[stableUrl]==='missing'} data-offline-availability={$availability.online?undefined:($availability.statuses[stableUrl]??'unknown')} title={offlineHint||undefined} onclick={()=>{playAudio(hit.audio);open=false;}}><strong>{hit.audio.title}</strong>{#if offlineHint}<p class="text-2xs opacity-60">{offlineHint}</p>{/if}{#if hit.line}<p class="truncate text-xs opacity-60">{hit.line}</p>{/if}</button></li>{/each}</ul>{#if !busy&&q.trim()&&!hits.length&&!error&&!timedOut&&completed===total}<p>无结果</p>{/if}</div></Sheet>

<style>
  /* 确认缺失（离线 + 未完整缓存）除减淡外再加虚线描边；未知状态不加，避免误报缺失（issue #14）。 */
  .offline-missing { opacity: 0.55; outline: 1px dashed var(--color-warning); outline-offset: -1px; }
</style>
