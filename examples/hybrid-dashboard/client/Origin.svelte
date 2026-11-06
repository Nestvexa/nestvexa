<script>
  // Deliberate hydration mismatch (diagnostics page): structure differs per side.
  let { island } = $props();
  const server = typeof window === 'undefined';
</script>

{#if server}
  <p class="origin">Rendered in server</p>
{:else}
  <p class="origin">Rendered in <strong>browser</strong> ({island.id})</p>
{/if}
