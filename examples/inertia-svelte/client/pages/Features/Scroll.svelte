<script lang="ts">
  import { InfiniteScroll } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { items }: FeaturePages['Features/Scroll'] = $props();
</script>

<svelte:head>
  <title>Infinite scroll · Nestvexa Svelte</title>
</svelte:head>

<h1>Infinite scroll</h1>
<InfiniteScroll data="items" buffer={200}>
  {#snippet loading()}
    <p role="status">Loading more items…</p>
  {/snippet}
  <ul aria-label="Items" data-testid="items">
    {#each items.data as item (item.id)}
      <li class="tall-item">{item.label}</li>
    {/each}
  </ul>
</InfiniteScroll>
