<script lang="ts">
  import '../app.css';
  import Player from '$lib/Player.svelte';
  import { onMount } from 'svelte';
  import { Capacitor } from '@capacitor/core';

  onMount(() => {
    if (Capacitor.getPlatform() !== 'ios') return;
    const viewport = document.querySelector('meta[name="viewport"]');
    const original = viewport?.getAttribute('content');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    document.documentElement.classList.add('native-ios');
    return () => {
      document.documentElement.classList.remove('native-ios');
      if (original != null) viewport?.setAttribute('content', original);
    };
  });

  let { children } = $props();
</script>

{@render children()}
<Player />
