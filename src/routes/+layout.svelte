<script lang="ts">
  import '../app.css';
  import Player from '$lib/Player.svelte';

  let { children } = $props();
</script>

{@render children()}
<Player />
