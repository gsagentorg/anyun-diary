<script lang="ts">
import {onMount,untrack,tick} from 'svelte';
import {page} from '$app/state';
import {player,setPlayerCatalog} from '$lib/player.svelte.ts';
import {backend,initBackend,fetchIndex,loadMonth,currentMonthId,isNativeApp} from '$lib/backend.svelte';
import {browseWindow} from '$lib/supply.js';
import {theme,toggleTheme} from '$lib/theme.svelte.ts';
import * as publicEnv from '$env/static/public';
import Chip from '$lib/components/Chip.svelte';
import BrandImage from '$lib/components/BrandImage.svelte';
import { brandSrc } from '$lib/brand-runtime';
import ContinuousBrowse from '$lib/ContinuousBrowse.svelte';
import BrowseSkeleton from '$lib/components/BrowseSkeleton.svelte';
import {ListMusic,Sun,Moon,Monitor,Search,HardDrive} from 'lucide-svelte';
import {browser} from '$app/environment';
import {nativeCacheAvailable} from '$lib/native-cache';
const viewScroll=[0,0,0];
let cancelRestore=()=>{};
async function switchView(next:number){
 if(next===view)return;cancelRestore();viewScroll[view]=window.scrollY;view=next;const target=viewScroll[next];await tick();
 // Dynamic view imports can grow the document after tick; observe layout rather than retrying every frame.
 const restore=()=>window.scrollTo(0,target);
 const observer=new ResizeObserver(restore);
 const cleanup=()=>{observer.disconnect();for(const event of ['wheel','pointerdown','keydown'])window.removeEventListener(event,cleanup);};
 cancelRestore=cleanup;
 for(const event of ['wheel','pointerdown','keydown'])window.addEventListener(event,cleanup,{once:true,passive:true});
 observer.observe(document.body);restore();
}
let view=$state(0),searchOpen=$state(false),playlistOpen=$state(true),selected=$state(currentMonthId());
let cacheOpen=$state(false);
// 原生缓存入口只在 App 内出现；网页端没有这层缓存，不给假入口。
const showCacheEntry=browser&&nativeCacheAvailable();
let rangeFrom=$state(''),rangeTo=$state(''),ready=$state(false);
let endAt=$state(Math.floor(Date.now()/1000)+1);
const startAt=$derived(backend.manifest?.queryMonthLimit===2?browseWindow(selected,endAt).startAt:-Infinity);
const laneMode=$derived(page.url.searchParams.get('lane')==='linear'?'linear':'compress');
const months=$derived((backend.manifest?.months??[]).filter(m=>m.available).sort((a,b)=>b.startAt-a.startAt));
let expandedDay=$state<number|null>(null);
let heatFrom=$state(''),heatTo=$state('');
const heatAudios=$derived(Object.values(backend.summaries).flat().filter(a=>a.startAt>=startAt&&a.startAt<endAt));
let revealed=$state(1);
const refs=$derived(months.slice(0,revealed));
$effect(()=>{for(const ref of refs)if(!backend.summaries[ref.id]&&!backend.loading[ref.id]&&!backend.errors[ref.id])void loadMonth(ref.id).catch(()=>{});});
function continueHistory(node:HTMLElement){let visible=false;const advance=()=>{if(visible&&window.scrollY>0&&revealed<months.length)revealed++;};const observer=new IntersectionObserver(entries=>{visible=entries.some(e=>e.isIntersecting);advance();},{rootMargin:'0px'});observer.observe(node);const wheel=(e:WheelEvent)=>{if(e.deltaY>0&&visible&&revealed<months.length)revealed++;};window.addEventListener('scroll',advance,{passive:true});window.addEventListener('wheel',wheel,{passive:true});return {destroy:()=>{observer.disconnect();window.removeEventListener('scroll',advance);window.removeEventListener('wheel',wheel);}};}
onMount(()=>{
 try{const v=JSON.parse(localStorage.getItem('anyun-view-v1')??'{}');if(Number.isInteger(v.view)&&v.view>=0&&v.view<3)view=v.view;if(typeof v.plOpen==='boolean')playlistOpen=v.plOpen;rangeFrom=typeof v.rangeFrom==='string'?v.rangeFrom:'';rangeTo=typeof v.rangeTo==='string'?v.rangeTo:'';}catch{}
 const from=page.url.searchParams.get('from')??'',to=page.url.searchParams.get('to')??'';
 if(/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to)&&from<=to){rangeFrom=from;rangeTo=to;}
 ready=true;initBackend();const refresh=()=>{if(document.visibilityState==='hidden')return;endAt=Math.floor(Date.now()/1000)+1;selected=currentMonthId();void fetchIndex();};const timer=setInterval(refresh,30000);document.addEventListener('visibilitychange',refresh);window.addEventListener('pageshow',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('pageshow',refresh);};
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
        <BrandImage
          src={brandSrc('avatar.png')}
          alt="安允日记"
          cls="h-8 w-8 shrink-0 rounded-full border border-base-300 object-cover"
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
              onclick={() => void switchView(i)}
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
        {#if showCacheEntry}
          <button
            class="rounded-full border border-base-300 p-1.5 transition hover:border-accent"
            onclick={() => (cacheOpen = true)}
            aria-label="本地缓存"
            title="本地缓存"
          >
            <HardDrive class="h-4 w-4" />
          </button>
        {/if}
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
        <BrandImage
          src={brandSrc('cover.jpg')}
          alt="直播间封面"
          cls="h-9 w-16 shrink-0 rounded-md object-cover"
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
        <BrandImage
          src={brandSrc('cover.jpg')}
          alt="直播间封面"
          cls="h-9 w-16 shrink-0 rounded-md object-cover"
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
{#if player.error&&!player.track}<p role="alert" class="text-xs text-warning">{player.error}</p>{/if}
{#if backend.error}<p role="alert">{backend.error} <button onclick={()=>void fetchIndex()}>重试目录</button></p>{:else if !backend.manifest}<BrowseSkeleton/>{/if}
{#if backend.manifest}
{#if view===2&&months.length&&!Object.keys(backend.summaries).length}
{#if backend.errors[months[0].id]}<p role="alert">{backend.errors[months[0].id]} <button onclick={()=>void loadMonth(months[0].id).catch(()=>{})}>重试此月</button></p>{:else}<BrowseSkeleton label="正在加载热力数据…"/>{/if}
{:else if view===2}{#await import('$lib/Heatmap.svelte') then m}<m.default audios={heatAudios} bind:from={heatFrom} bind:to={heatTo} onOlder={()=>{if(revealed<months.length){revealed++;}}}/>{/await}
{:else}{#if Object.keys(backend.summaries).length}<ContinuousBrowse {view} {laneMode} {startAt} {endAt} bind:expanded={expandedDay}/>{/if}
{#each refs as ref (ref.id)}{#if !backend.summaries[ref.id]}{#if backend.errors[ref.id]}<p role="alert">{backend.errors[ref.id]} <button onclick={()=>void loadMonth(ref.id).catch(()=>{})}>重试此月</button></p>{:else}<BrowseSkeleton label={"正在加载 "+ref.id+"…"}/>{/if}{/if}{/each}
{#if revealed<months.length}{#key revealed}<div use:continueHistory class="h-8" aria-label="继续加载历史月份"></div>{/key}{/if}{/if}
{/if}
{#if searchOpen}{#await import('$lib/components/SearchPanel.svelte') then module}<module.default bind:open={searchOpen}/>{/await}{/if}
{#if backend.prompt}{#await import('$lib/components/BackendSheet.svelte') then module}<module.default/>{/await}{/if}
{#if player.queueOpen}{#await import('$lib/components/QueueOverlay.svelte') then module}<module.default/>{/await}{/if}
{#if player.lyricsOpen}{#await import('$lib/components/LyricsSheet.svelte') then module}<module.default/>{/await}{/if}
{#if showCacheEntry}{#await import('$lib/components/CacheSheet.svelte') then module}<module.default open={cacheOpen} onClose={()=>cacheOpen=false}/>{/await}{/if}
</div>
