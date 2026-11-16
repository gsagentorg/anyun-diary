<script lang="ts">
import {onMount,untrack,tick} from 'svelte';
import {page} from '$app/state';
import {player,setPlayerCatalog} from '$lib/player.svelte.ts';
import {backend,initBackend,fetchIndex,loadMonth,currentMonthId,isNativeApp} from '$lib/backend.svelte';
import {monthBounds,shiftMonthId} from '$lib/month.js';
import {browseWindow} from '$lib/supply.js';
import {theme,toggleTheme} from '$lib/theme.svelte.ts';
import * as publicEnv from '$env/static/public';
import Chip from '$lib/components/Chip.svelte';
let view=$state(0),searchOpen=$state(false),playlistOpen=$state(true),selected=$state(currentMonthId());
let rangeFrom=$state(''),rangeTo=$state(''),ready=$state(false),previous=$state(false);
let endAt=$state(Math.floor(Date.now()/1000)+1);
const startAt=$derived(browseWindow(selected,endAt).startAt);
const laneMode=$derived(page.url.searchParams.get('lane')==='linear'?'linear':'compress');
const months=$derived((backend.manifest?.months??[]).filter(m=>m.available).sort((a,b)=>b.startAt-a.startAt));
const refs=$derived(months.filter(m=>(m.id===selected||m.id===shiftMonthId(selected,-1))&&m.endAt>startAt&&m.startAt<endAt));
const visibleRefs=$derived(previous?refs:refs.filter(m=>m.id===selected));
const audios=$derived(visibleRefs.flatMap(m=>backend.months[m.id]??[]).filter(a=>a.startAt>=startAt&&a.startAt<endAt));
const missing=$derived(refs.filter(m=>!backend.months[m.id]));
function choose(id:string){selected=id;endAt=id===currentMonthId()?Math.floor(Date.now()/1000)+1:monthBounds(id).endAt;previous=false;}
onMount(()=>{
 try{const v=JSON.parse(localStorage.getItem('anyun-view-v1')??'{}');if(Number.isInteger(v.view)&&v.view>=0&&v.view<3)view=v.view;if(typeof v.plOpen==='boolean')playlistOpen=v.plOpen;rangeFrom=typeof v.rangeFrom==='string'?v.rangeFrom:'';rangeTo=typeof v.rangeTo==='string'?v.rangeTo:'';}catch{}
 const from=page.url.searchParams.get('from')??'',to=page.url.searchParams.get('to')??'';
 if(/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to)&&from<=to){rangeFrom=from;rangeTo=to;}
 ready=true;initBackend();const timer=setInterval(()=>void fetchIndex(),30000);return()=>clearInterval(timer);
});
$effect(()=>{if(ready)try{localStorage.setItem('anyun-view-v1',JSON.stringify({view,plOpen:playlistOpen,rangeFrom,rangeTo}));}catch{}});
$effect(()=>{const snapshot=Object.values(backend.months).flat();untrack(()=>setPlayerCatalog(snapshot));});
$effect(()=>{void backend.generation;untrack(()=>choose(currentMonthId()));});
$effect(()=>{const ids=visibleRefs.map(m=>m.id);untrack(()=>{for(const id of ids)if(!backend.months[id]&&!backend.loading[id]&&!backend.errors[id])void loadMonth(id).catch(()=>{});});});
async function older(){previous=true;await tick();for(const ref of refs)if(!backend.months[ref.id]&&!backend.loading[ref.id])void loadMonth(ref.id).catch(()=>{});}
function scroll(e:Event){const el=e.currentTarget as HTMLElement;if(el.scrollTop+el.clientHeight>=el.scrollHeight-40){if(!previous)void older();else if(missing.length===0&&el.scrollTop>0)shift(1);}}
function shift(delta:number){const i=months.findIndex(m=>m.id===selected);if(months[i+delta]){choose(months[i+delta].id);}}
function share(){const url=new URL(location.href);if(rangeFrom&&rangeTo){url.searchParams.set('from',rangeFrom);url.searchParams.set('to',rangeTo);}else{url.searchParams.delete('from');url.searchParams.delete('to');}history.replaceState(history.state,'',url);}
  // 直播间状态
  type LiveInfo = {
    live: boolean | null;
    title: string | null;
    area: string | null;
    cover: string | null;
    checkedAt: string;
  };
  const rawRoomId = (publicEnv as unknown as Record<string, string | undefined>)['PUBLIC_LIVE_ROOM_ID'];
  const LIVE_ROOM_ID = rawRoomId && /^\d+$/.test(rawRoomId) ? Number(rawRoomId) : 0;
  const LIVE_URL = LIVE_ROOM_ID > 0 ? `https://live.bilibili.com/${LIVE_ROOM_ID}` : '';
  let liveInfo = $state<LiveInfo | null>(null);

  $effect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    // App 内没有 /api/live（服务端代理端点），跳过轮询，避免每 60s 白打一次 404
    if (!LIVE_URL || isNativeApp()) {
      liveInfo = null;
      return;
    }
    const load = async () => {
      try {
        const res = await fetch('/api/live');
        liveInfo = (await res.json()) as LiveInfo;
      } catch {
        liveInfo = null;
      }
    };
    load();
    id = setInterval(load, 60_000);
    return () => clearInterval(id);
  });


</script><svelte:head><title>安允日记</title></svelte:head>
<main class="mx-auto max-w-[1600px] px-4 py-6 pb-32"><header class="mb-5 flex flex-wrap items-center gap-3"><h1 class="mr-auto text-xl font-bold">安允日记</h1>{#each ['泳道时间轴','日卡片','热力图'] as label,i}<button class="rounded-full border px-3 py-1" aria-pressed={view===i} onclick={()=>view=i}>{label}</button>{/each}<button onclick={()=>searchOpen=true}>搜索</button><button onclick={()=>playlistOpen=!playlistOpen}>按日期生成</button><button onclick={toggleTheme}>主题：{theme.mode}</button>{#if isNativeApp()}<button onclick={()=>backend.prompt=true}>后端设置</button>{/if}</header>
  {#if LIVE_URL}
  <section class="lg:w-[38%]" aria-label="直播间">
    {#if liveInfo && liveInfo.live === true}
      <div class="flex items-center gap-2 rounded-lg border border-base-300 px-3 py-2">
        <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500"></span>
        <Chip variant="warning">直播中</Chip>
        <span class="min-w-0 truncate text-sm font-medium">{liveInfo.title ?? '安允日记'}</span>
        <a
          href={LIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto shrink-0 rounded-full border border-accent px-3 py-1 text-2xs text-accent transition hover:bg-base-200"
        >
          去直播间
        </a>
      </div>
    {:else if liveInfo && liveInfo.live === false}
      <div class="flex items-center gap-3 rounded-lg border border-base-300 px-3 py-2">
        <img
          src="/brand/cover.jpg"
          alt="直播间封面"
          class="h-9 w-16 shrink-0 rounded-md object-cover"
        />
        <span class="shrink-0 text-sm">未开播</span>
        {#if liveInfo.title}
          <span class="min-w-0 truncate text-2xs opacity-60">最近：{liveInfo.title}</span>
        {/if}
        <a
          href={LIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto shrink-0 rounded-full border border-accent px-3 py-1 text-2xs text-accent transition hover:bg-base-200"
        >
          去直播间
        </a>
      </div>
    {:else}
      <!-- 兜底：liveInfo 尚未拉到（首次加载/接口瞬时失败）或 live === null → 未开播版式，条不消失 -->
      <div class="flex items-center gap-3 rounded-lg border border-base-300 px-3 py-2">
        <img
          src="/brand/cover.jpg"
          alt="直播间封面"
          class="h-9 w-16 shrink-0 rounded-md object-cover"
        />
        <span class="shrink-0 text-sm">未开播</span>
        <a
          href={LIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto shrink-0 rounded-full border border-accent px-3 py-1 text-2xs text-accent transition hover:bg-base-200"
        >
          去直播间
        </a>
      </div>
    {/if}
  </section>
  {/if}


{#if playlistOpen}{#await import('$lib/Playlist.svelte')}<p>加载日期面板…</p>{:then module}<module.default bind:open={playlistOpen} bind:from={rangeFrom} bind:to={rangeTo}/><button class="my-2 text-xs text-accent" onclick={share}>将日期范围写入分享链接</button>{/await}{/if}
{#if backend.error}<p role="alert">{backend.error} <button onclick={()=>void fetchIndex()}>重试目录</button></p>{:else if !backend.manifest}<div role="status" aria-label="正在加载目录" class="animate-pulse space-y-4">{#each Array(5) as _}<div class="h-16 rounded bg-base-200"></div>{/each}</div>{:else}
<nav class="my-4 flex items-center justify-between gap-3" aria-label="月份"><button disabled={months.findIndex(m=>m.id===selected)<=0} onclick={()=>shift(-1)}>较新月份</button><select aria-label="浏览月份" value={selected} onchange={(e)=>choose(e.currentTarget.value)}>{#each months as month (month.id)}<option value={month.id}>{month.id}（{month.count}首）</option>{/each}</select><button disabled={months.findIndex(m=>m.id===selected)>=months.length-1} onclick={()=>shift(1)}>较早月份</button></nav>
<section class="max-h-[70vh] min-h-48 overflow-auto rounded-lg border border-base-300 p-3" onscroll={scroll} aria-label="按自然月滚动浏览">
<p class="mb-3 text-xs opacity-60">{new Date(startAt*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} — {new Date((endAt-1)*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>
{#if audios.length}
{#if view===0}{#await import('$lib/Timeline.svelte')}<p>加载时间轴…</p>{:then module}<module.default {audios} {laneMode}/>{/await}
{:else if view===1}{#await import('$lib/DayStrip.svelte')}<p>加载日卡片…</p>{:then module}<module.default {audios}/>{/await}
{:else}{#await import('$lib/Heatmap.svelte')}<p>加载热力图…</p>{:then module}<module.default {audios}/>{/await}{/if}
{:else if visibleRefs.length&&visibleRefs.every(m=>backend.months[m.id])}<p>此自然月窗口暂无音频。</p>
{:else if !refs.length}<p>当前窗口尚未发布或不可查询，请选择可用月份。</p>{/if}
{#each visibleRefs as ref (ref.id)}
{#if backend.loading[ref.id]}<div role="status" class="animate-pulse space-y-3 py-4"><div class="h-12 rounded bg-base-200"></div><p>正在加载 {ref.id}…</p></div>
{:else if backend.errors[ref.id]}<p role="alert">{ref.id}：{backend.errors[ref.id]} <button onclick={()=>void loadMonth(ref.id).catch(()=>{})}>重试此月</button></p>{/if}
{/each}
{#if !previous&&refs.some(m=>m.id!==selected)}<button class="my-4 w-full rounded border border-base-300 p-3" onclick={older}>继续滚动加载前月</button>{/if}
{#if previous&&missing.length===0}<button class="my-4 w-full rounded border border-base-300 p-3 text-sm" disabled={months.findIndex(m=>m.id===selected)>=months.length-1} onclick={()=>shift(1)}>此窗口已完整加载 · 浏览更早月份</button>{/if}
</section>{/if}
{#if searchOpen}{#await import('$lib/components/SearchPanel.svelte') then module}<module.default bind:open={searchOpen}/>{/await}{/if}
{#if backend.prompt}{#await import('$lib/components/BackendSheet.svelte') then module}<module.default/>{/await}{/if}
{#if player.queueOpen}{#await import('$lib/components/QueueOverlay.svelte') then module}<module.default/>{/await}{/if}
{#if player.lyricsOpen}{#await import('$lib/components/LyricsSheet.svelte') then module}<module.default/>{/await}{/if}
</main>
