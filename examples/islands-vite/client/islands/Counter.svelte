<script lang="ts">
  import { untrack } from 'svelte';
  let { label, start }: { label: string; start: number } = $props();
  // The server props seed local state once; later prop changes are ignored.
  let count = $state(untrack(() => start));
</script>

<div class="counter" data-framework="svelte">
  <p id="svelte-count">{label}: {count}</p>
  <button type="button" onclick={() => (count += 1)}>Increment Svelte</button>
</div>
