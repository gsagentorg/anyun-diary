<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    variant = 'neutral',
    size = 'xs',
    children,
  }: {
    variant?: 'accent' | 'neutral' | 'warning';
    size?: 'sm' | 'xs';
    children?: Snippet;
  } = $props();

  const styles = $derived(
    [
      'inline-flex items-center gap-1 rounded-full border',
      size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-2xs',
      variant === 'accent'
        ? 'border-accent text-accent'
        : variant === 'warning'
          ? 'border-warning text-warning'
          : 'border-base-300 opacity-80',
    ].join(' ')
  );
</script>

<span class={styles}>{@render children?.()}</span>
