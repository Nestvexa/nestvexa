<script lang="ts">
  import type { IslandContext } from '@nestvexa/islands/client';

  let { label = 'Status', island }: { label?: string; island: IslandContext } = $props();
  let count = $state(0);
  function increment(): void {
    count++;
    island.emit('status.clicked', { count });
  }
</script>

<button type="button" onclick={increment}>{label}: {count}</button>
