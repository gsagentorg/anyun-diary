<script lang="ts">
import {onMount,untrack} from 'svelte';
import {page} from '$app/state';
import {player,setPlayerCatalog} from '$lib/player.svelte.ts';
import {backend,initBackend,fetchIndex,loadMonth,currentMonthId,isNativeApp} from '$lib/backend.svelte';
import {browseWindow} from '$lib/supply.js';
import {theme,toggleTheme} from '$lib/theme.svelte.ts';
import * as publicEnv from '$env/static/public';
import Chip from '$lib/components/Chip.svelte';
import LazyMonth from '$lib/LazyMonth.svelte';
import {ListMusic,Sun,Moon,Monitor,Search} from 'lucide-svelte';
let view=$state(0),searchOpen=$state(false),playlistOpen=$state(true),selected=$state(currentMonthId());
let rangeFrom=$state(''),rangeTo=$state(''),ready=$state(false);
let endAt=$state(Math.floor(Date.now()/1000)+1);
const startAt=$derived(backend.manifest?.queryMonthLimit===2?browseWindow(selected,endAt).startAt:-Infinity);
const laneMode=$derived(page.url.searchParams.get('lane')==='linear'?'linear':'compress');
const months=$derived((backend.manifest?.months??[]).filter(m=>m.available).sort((a,b)=>b.startAt-a.startAt));
const expandedDays=$state<Record<string,number|null>>({});
let heatFrom=$state(''),heatTo=$state('');
const heatAudios=$derived(Object.values(backend.summaries).flat().filter(a=>a.startAt>=startAt&&a.startAt<endAt));
let revealed=$state(1);
const refs=$derived(months.slice(0,revealed));
function continueHistory(node:HTMLElement){let visible=false;const advance=()=>{if(visible&&window.scrollY>0&&revealed<months.length)revealed++;};const observer=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);advance();},{rootMargin:'0px'});observer.observe(node);const wheel=(e:WheelEvent)=>{if(e.deltaY>0&&visible&&revealed<months.length)revealed++;};window.addEventListener('scroll',advance,{passive:true});window.addEventListener('wheel',wheel,{passive:true});return {destroy:()=>{observer.disconnect();window.removeEventListener('scroll',advance);window.removeEventListener('wheel',wheel);}};}
onMount(()=>{
 try{const v=JSON.parse(localStorage.getItem('anyun-view-v1')??'{}');if(Number.isInteger(v.view)&&v.view>=0&&v.view<3)view=v.view;if(typeof v.plOpen==='boolean')playlistOpen=v.plOpen;rangeFrom=typeof v.rangeFrom==='string'?v.rangeFrom:'';rangeTo=typeof v.rangeTo==='string'?v.rangeTo:'';}catch{}
 const from=page.url.searchParams.get('from')??'',to=page.url.searchParams.get('to')??'';
 if(/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to)&&from<=to){rangeFrom=from;rangeTo=to;}
 ready=true;initBackend();const timer=setInterval(()=>void fetchIndex(),30000);return()=>clearInterval(timer);
});
$effect(()=>{if(ready)try{localStorage.setItem('anyun-view-v1',JSON.stringify({view,plOpen:playlistOpen,rangeFrom,rangeTo}));}catch{}});
$effect(()=>{const snapshot=Object.values(backend.months).flat();untrack(()=>setPlayerCatalog(snapshot));});
$effect(()=>{void backend.generation;untrack(()=>revealed=1);});
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
<div class="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 {player.track ? 'pb-32' : ''}">
  <header
    class="sticky top-0 z-30 -mx-4 mb-4 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur sm:-mx-6 sm:mb-6 sm:px-6 lg:-mx-8 lg:px-8"
  >
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div class="flex items-center gap-2">
        <img
          src="/brand/avatar.jpg"
          alt="安允日记"
          class="h-8 w-8 shrink-0 rounded-full border border-base-300 object-cover"
        />
        <div class="min-w-0">
          <h1 class="text-lg font-bold tracking-tight leading-none">安允日记</h1>
          <p class="mt-1 hidden text-xs opacity-60 lg:block">
            直播歌单时间线 · 数据由文件名 + 切片元数据自动生成
          </p>
        </div>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap items-center gap-2" role="tablist" aria-label="视图切换">
          {#each ['泳道时间轴', '日卡片', '热力图'] as v, i}
            <button
              role="tab"
              aria-selected={i === view}
              class="rounded-full border px-3 py-1 text-sm transition {i === view
                ? 'border-accent text-accent'
                : 'border-base-300 opacity-60 hover:opacity-100'}"
              onclick={() => (view = i)}
            >
              {v}
            </button>
          {/each}
        </div>
        <button
          class="rounded-full border border-base-300 p-1.5 transition hover:border-accent"
          onclick={() => (searchOpen = true)}
          aria-label="搜索"
          title="搜索"
        >
          <Search class="h-4 w-4" />
        </button>
        <button
          class="rounded-full border border-base-300 p-1.5 transition hover:border-accent"
          onclick={toggleTheme}
          aria-label={theme.mode === 'light' ? '浅色模式' : theme.mode === 'dark' ? '深色模式' : '跟随系统'}
          title={theme.mode === 'light' ? '浅色模式' : theme.mode === 'dark' ? '深色模式' : '跟随系统'}
        >
          {#if theme.mode === 'dark'}<Sun class="h-4 w-4" />
          {:else if theme.mode === 'light'}<Moon class="h-4 w-4" />
          {:else}<Monitor class="h-4 w-4" />{/if}
        </button>
        <button
          class="flex items-center gap-1.5 rounded-full border border-base-300 px-3 py-1 text-sm transition hover:bg-base-200 {playlistOpen
            ? 'border-accent text-accent'
            : ''}"
          onclick={() => (playlistOpen = !playlistOpen)}
          aria-expanded={playlistOpen}
        >
          <ListMusic class="h-4 w-4" /> 播放列表
        </button>
      </div>
    </div>
  </header>

  <div class="mb-4 flex flex-col gap-4 sm:mb-6 lg:flex-row lg:items-start">
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


<div class="lg:flex-1">
{#if playlistOpen}<div class="max-h-[60vh] overflow-y-auto rounded-lg border border-base-300 bg-base-100">{#await import('$lib/Playlist.svelte') then module}<module.default bind:open={playlistOpen} bind:from={rangeFrom} bind:to={rangeTo}/>{/await}</div>
{:else}<button class="flex w-full items-center justify-between rounded-lg border border-base-300 bg-base-100 px-4 py-2 text-sm" onclick={()=>playlistOpen=true}><span class="flex items-center gap-1.5"><ListMusic class="h-4 w-4"/> 播放列表</span><span class="text-xs opacity-60">展开</span></button>{/if}
</div></div>
{#if backend.error}<p role="alert">{backend.error} <button onclick={()=>void fetchIndex()}>重试目录</button></p>{:else if !backend.manifest}<p role="status">正在加载目录…</p>{/if}
{#if view===2}{#await import('$lib/Heatmap.svelte') then m}<m.default audios={heatAudios} bind:from={heatFrom} bind:to={heatTo} onOlder={()=>{if(revealed<months.length){const ref=months[revealed++];void loadMonth(ref.id).catch(()=>{});}}}/>{/await}
{:else}{#each refs as ref (ref.id)}<LazyMonth {ref} {view} {laneMode} {startAt} {endAt} {heatFrom} {heatTo} bind:expanded={()=>expandedDays[ref.id]??null,(value)=>expandedDays[ref.id]=value}/>{/each}
{#if revealed<months.length}{#key revealed}<div use:continueHistory class="h-8" aria-label="继续加载历史月份"></div>{/key}{/if}{/if}
{#if searchOpen}{#await import('$lib/components/SearchPanel.svelte') then module}<module.default bind:open={searchOpen}/>{/await}{/if}
{#if backend.prompt}{#await import('$lib/components/BackendSheet.svelte') then module}<module.default/>{/await}{/if}
{#if player.queueOpen}{#await import('$lib/components/QueueOverlay.svelte') then module}<module.default/>{/await}{/if}
{#if player.lyricsOpen}{#await import('$lib/components/LyricsSheet.svelte') then module}<module.default/>{/await}{/if}
</div>
