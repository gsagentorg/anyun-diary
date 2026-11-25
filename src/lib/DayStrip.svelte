<script lang="ts">
  import {loadMonth,backend} from './backend.svelte';
  import {onDestroy} from 'svelte';
  import {createLatestOperation} from './interactions.js';
  import {createOfflineAvailability,offlineRowHint,resolveBrowseAudios} from './offline-availability';
  const availability=createOfflineAvailability();
  const playbackOperation=createLatestOperation();
  onDestroy(()=>playbackOperation.cancel());
  $effect(()=>{void backend.generation;void backend.base;playbackOperation.cancel();});
  $effect(()=>availability.setTargets(days.filter(([day])=>day===expanded).flatMap(([,songs])=>songs.map(audio=>audioUrl(audio.opus))),backend.generation+':'+backend.base));
  import type { Audio } from './types';
  import { fmtDay, fmtDur, hueOf, audioUrl } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playAudio, adopt, makeTrack } from './player.svelte.ts';
  import { ListMusic } from 'lucide-svelte';
  import Chip from './components/Chip.svelte';
  import StateHint from './components/StateHint.svelte';

  let { audios, expanded = $bindable<number|null>(null) }: { audios: Audio[]; expanded?:number|null } = $props();
  const days = $derived.by(() => {
    const groups = new Map<number, Audio[]>();
    for (const audio of [...audios].sort((a,b) => a.startAt-b.startAt || a.id.localeCompare(b.id))) {
      const day = shDayStart(audio.startAt);
      const songs = groups.get(day) ?? [];
      songs.push(audio); groups.set(day, songs);
    }
    return [...groups].sort(([a],[b]) => b-a);
  });

  const clock = (t: number) => new Date(t*1000).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
  function toggle(day: number) { expanded = expanded === day ? null : day; }
  async function resolveAndPlay(songs:Audio[],replace=false) {
    const context=backend.generation+':'+backend.base;
    try {
      await playbackOperation.run((signal:AbortSignal)=>resolveBrowseAudios(songs,loadMonth,{signal,isCurrent:()=>context===backend.generation+':'+backend.base}),
        (full:Audio[])=>{if(replace)adopt(full.map(makeTrack),0);else if(full[0])playAudio(full[0]);});
    } catch(error) { if((error as Error)?.name!=='AbortError')throw error; }
  }
  function replace(songs:Audio[]){return resolveAndPlay(songs,true);}
  function play(audio:Audio){return resolveAndPlay([audio]);}
</script>

<div data-day-grid class="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
  {#if days.length === 0}
    <div class="sm:col-span-2 xl:col-span-3"><StateHint kind="empty" /></div>
  {/if}
  {#each days as [day,songs] (day)}
    <section data-day={day} data-month-id={songs[0]?.monthId} class="block w-full rounded-lg border border-base-300 bg-base-100 p-4 text-left transition hover:border-accent" class:border-accent={expanded === day}>
      <div class="flex items-baseline justify-between gap-2">
        <button class="text-left text-base font-bold" aria-expanded={expanded === day} onclick={() => toggle(day)}>{fmtDay(day)}</button>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button title="用这一天的歌替换播放列表" onclick={() => replace(songs)}>
            <Chip variant="accent"><ListMusic class="h-3 w-3" /> 替换列表</Chip>
          </button>
          <button aria-label="展开或收起当天歌曲" aria-expanded={expanded === day} onclick={() => toggle(day)}><Chip>🎵 {songs.length} 歌</Chip></button>
        </div>
      </div>
      {#if expanded === day}
        <ol class="mt-3 space-y-1 border-t border-base-300 pt-3" >
          {#each songs as audio, i (audio.id)}
            {@const active = player.track?.audio.id === audio.id}
            {@const stableUrl=audioUrl(audio.opus)}
            {@const offlineHint=offlineRowHint($availability,stableUrl)}
            <li>
              <button class="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition hover:bg-base-200" class:bg-accent={active} class:text-accent-content={active} class:offline-missing={!$availability.online&&$availability.statuses[stableUrl]==='missing'} data-offline-availability={$availability.online?undefined:($availability.statuses[stableUrl]??'unknown')} title={offlineHint||undefined} aria-label={(audio.title||'（未识别）')+(offlineHint?'，'+offlineHint:'')} onclick={() => void play(audio)}>
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hueOf(audio.title)} var(--color-song-hue-sat) var(--color-song-hue-light))"></span>
                <span class="w-10 shrink-0 text-2xs tabular-nums opacity-50">{clock(audio.startAt)}</span>
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{i+1}. {audio.title || '（未识别）'}</span>
                {#if offlineHint}<span class="sr-only">{offlineHint}</span><span aria-hidden="true" class="shrink-0 text-2xs opacity-60">{$availability.statuses[stableUrl]==='missing'?'未完整缓存':'离线可用性未知'}</span>{/if}
                <span class="shrink-0 text-xs tabular-nums opacity-60">{fmtDur(audio.duration ?? 0)}</span>
              </button>
            </li>
          {/each}
        </ol>

      {/if}
    </section>
  {/each}
</div>

<style>
  /* 确认缺失（离线 + 未完整缓存）除减淡外再加虚线描边；未知状态不加，避免误报缺失（issue #14）。 */
  .offline-missing { opacity: 0.55; outline: 1px dashed var(--color-warning); outline-offset: -1px; }
</style>
