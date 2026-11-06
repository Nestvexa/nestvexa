<script>
  import { onMount } from 'svelte';
  import { track } from './track.js';
  let { label } = $props();
  let online = $state(true);
  onMount(() => {
    track('status-widget', 'mount');
    return () => track('status-widget', 'unmount');
  });
</script>

<div class="widget">
  <p id="widget-status">{label}: {online ? 'online' : 'paused'}</p>
  <button type="button" onclick={() => (online = !online)}>Toggle status</button>
</div>
