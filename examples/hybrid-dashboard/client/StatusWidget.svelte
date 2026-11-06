<script>
  import { onMount } from 'svelte';
  import { createActionStores } from './generated/actions-client.svelte.js';
  import { track } from './track.js';
  let { label, workspace, island } = $props();
  let online = $state(true);
  // Generated Svelte store for dashboard.set-status (store contract: $status).
  const status = createActionStores(island.services.actions).dashboardSetStatus();
  onMount(() => {
    track('status-widget', 'mount');
    return () => track('status-widget', 'unmount');
  });
  function toggle() {
    online = !online;
    // Signed server props travel back so the server can verify the workspace.
    if (island.signed)
      void status.run({
        online,
        props: island.signed.props,
        token: island.signed.token,
      });
  }
</script>

<div class="widget">
  <p id="widget-status">{label}: {online ? 'online' : 'paused'}</p>
  <p id="widget-workspace">
    {$status.data ? `Saved for ${$status.data.workspace}` : `Workspace ${workspace}`}
  </p>
  <button type="button" onclick={toggle}>Toggle status</button>
</div>
