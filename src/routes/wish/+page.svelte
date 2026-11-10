<script lang="ts">
  const wishes = [
    { title: 'Let Me Go (女独奏)', artist: '罐装毕加索', note: '大肥鱼摸鱼歌' },
    { title: 'Take Me Hand', artist: 'DAISHI DANCE / Cécile Corbel', note: '' },
    { title: 'SOLAR DAWN', artist: '', note: '' },
  ];
</script>

<div class="mx-auto w-full max-w-2xl px-4 py-8">
  <div class="flex items-center gap-3">
    <a href="/" class="text-sm opacity-60 transition hover:opacity-100">← 返回</a>
    <h1 class="text-lg font-bold tracking-tight">许愿池</h1>
  </div>

  <p class="mt-6 text-center text-xl font-semibold tracking-tight">我又来为难主猫了awa</p>

  <ul class="mt-6 flex flex-col gap-2">
    {#each wishes as w, i (w.title)}
      <li class="flex items-center gap-3 rounded-lg border border-base-300 px-3 py-2 text-sm">
        <span class="text-lg" aria-hidden="true">🌟</span>
        <div class="min-w-0">
          <p class="truncate font-medium">{w.title}</p>
          <p class="truncate text-xs opacity-60">
            {#if w.artist}{w.artist}{#if w.note} · {w.note}{/if}{:else}{w.note}{/if}
          </p>
        </div>
        <span class="ml-auto shrink-0 text-2xs opacity-45">愿望 {i + 1}</span>
      </li>
    {/each}
  </ul>
</div>
