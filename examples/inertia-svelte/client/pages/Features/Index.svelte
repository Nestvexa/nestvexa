<script lang="ts">
  import { Link, WhenVisible, usePoll } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { tick, below }: FeaturePages['Features/Index'] = $props();
  const poll = usePoll(400, { only: ['tick'] });
</script>

<svelte:head>
  <title>Client features · Nestvexa Svelte</title>
</svelte:head>

<h1>Client features</h1>
<nav aria-label="Feature pages" class="stack">
  <Link href="/features/prefetched" prefetch="hover" cacheFor="1m">
    Prefetched page
  </Link>
  <Link href="/features/scroll">Infinite scroll</Link>
</nav>
<p data-testid="tick">Tick {tick}</p>
<p data-testid="polling">{poll.polling ? 'Polling' : 'Stopped'}</p>
<button type="button" onclick={() => poll.stop()}>Stop polling</button>
<div class="spacer" aria-hidden="true"></div>
<WhenVisible data="below" buffer={0}>
  {#snippet fallback()}
    <p data-testid="below">Not loaded yet</p>
  {/snippet}
  <p data-testid="below">{below}</p>
</WhenVisible>
