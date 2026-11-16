<script lang="ts">
  import type { Audio } from './types';
  import { fmtDay, fmtDur, hueOf } from './types';
  import { shDayStart } from './playlist-core';
  import { player, playAudio, adopt, makeTrack } from './player.svelte.ts';
  import { ListMusic } from 'lucide-svelte';
  import Chip from './components/Chip.svelte';
  import StateHint from './components/StateHint.svelte';

  let { audios }: { audios: Audio[] } = $props();
  const days = $derived.by(() => {
    const groups = new Map<number, Audio[]>();
    for (const audio of [...audios].sort((a,b) => a.startAt-b.startAt || a.id.localeCompare(b.id))) {
      const day = shDayStart(audio.startAt);
      const songs = groups.get(day) ?? [];
      songs.push(audio); groups.set(day, songs);
    }
    return [...groups].sort(([a],[b]) => a-b);
  });
  let open = $state<number | null>(null);
  let page = $state(0);
  let songPage = $state(0);
  const daySize = 30, songSize = 60;
  $effect(() => { void audios; page = 0; open = null; songPage = 0; });
  const clock = (t: number) => new Date(t*1000).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
  function toggle(day: number) { open = open === day ? null : day; songPage = 0; }
  function replace(songs: Audio[]) { adopt(songs.map(makeTrack), 0); }
</script>

<div class="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
  {#if days.length === 0}
    <div class="sm:col-span-2 xl:col-span-3"><StateHint kind="empty" /></div>
  {/if}
  {#each days.slice(page*daySize,(page+1)*daySize) as [day,songs] (day)}
    <section class="block w-full rounded-lg border border-base-300 bg-base-100 p-4 text-left transition hover:border-accent" class:border-accent={open === day}>
      <div class="flex items-baseline justify-between gap-2">
        <button class="text-left text-base font-bold" aria-expanded={open === day} onclick={() => toggle(day)}>{fmtDay(day)}</button>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button title="用这一天的歌替换播放列表" onclick={() => replace(songs)}>
            <Chip variant="accent"><ListMusic class="h-3 w-3" /> 替换列表</Chip>
          </button>
          <button aria-label="展开或收起当天歌曲" aria-expanded={open === day} onclick={() => toggle(day)}><Chip>🎵 {songs.length} 歌</Chip></button>
        </div>
      </div>
      {#if open === day}
        <ol class="mt-3 space-y-1 border-t border-base-300 pt-3" start={songPage*songSize+1}>
          {#each songs.slice(songPage*songSize,(songPage+1)*songSize) as audio, i (audio.id)}
            {@const active = player.track?.audio.id === audio.id}
            <li>
              <button class="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition hover:bg-base-200" class:bg-accent={active} class:text-accent-content={active} onclick={() => playAudio(audio)}>
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:hsl({hueOf(audio.title)} var(--color-song-hue-sat) var(--color-song-hue-light))"></span>
                <span class="w-10 shrink-0 text-2xs tabular-nums opacity-50">{clock(audio.startAt)}</span>
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{songPage*songSize+i+1}. {audio.title || '（未识别）'}</span>
                <span class="shrink-0 text-xs tabular-nums opacity-60">{fmtDur(audio.duration ?? 0)}</span>
              </button>
            </li>
          {/each}
        </ol>
        {#if songs.length > songSize}
          <nav class="mt-2 flex items-center gap-3 text-xs" aria-label="当天歌曲分页">
            <button disabled={songPage===0} onclick={() => songPage--}>上一页</button>
            <span>{songPage+1} / {Math.ceil(songs.length/songSize)}</span>
            <button disabled={(songPage+1)*songSize>=songs.length} onclick={() => songPage++}>下一页</button>
          </nav>
        {/if}
      {/if}
    </section>
  {/each}
</div>
{#if days.length > daySize}
  <nav class="flex items-center gap-4 py-3 text-xs" aria-label="日卡片日期分页">
    <button disabled={page===0} onclick={() => {page--;open=null;songPage=0;}}>上一页</button>
    <span>{page+1} / {Math.ceil(days.length/daySize)}</span>
    <button disabled={(page+1)*daySize>=days.length} onclick={() => {page++;open=null;songPage=0;}}>下一页</button>
  </nav>
{/if}
