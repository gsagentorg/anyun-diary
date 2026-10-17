<script lang="ts">
  let { width }: { width: number } = $props();

  const step = $derived(width >= 1200 ? 2 : width >= 800 ? 3 : 6);

  const major = $derived(
    Array.from({ length: Math.floor(24 / step) + 1 }, (_, i) => i * step)
  );

  const half = $derived(
    step <= 3
      ? Array.from({ length: 47 }, (_, i) => (i + 1) * 0.5).filter(
          (h) => h % step !== 0
        )
      : []
  );

  const pct = (h: number) => (h / 24) * 100;
</script>

<div class="relative h-5 w-full">
  {#each half as h}
    <div
      class="absolute bottom-0 h-2 w-px opacity-50"
      style:background="var(--color-grid)"
      style:left={pct(h) + '%'}
    ></div>
  {/each}

  {#each major as h}
    <div
      class="absolute bottom-0 h-3 w-px"
      style:background="var(--color-grid)"
      style:left={pct(h) + '%'}
    ></div>
    <span
      class="absolute top-0 text-2xs tabular-nums opacity-55 {h === 24
        ? '-translate-x-full'
        : '-translate-x-1/2'}"
      style:left={pct(h) + '%'}>{String(h).padStart(2, '0')}:00</span
    >
  {/each}
</div>
