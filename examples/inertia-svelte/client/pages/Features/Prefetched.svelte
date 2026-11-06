<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { renders }: FeaturePages['Features/Prefetched'] = $props();
</script>

<svelte:head>
  <title>Prefetched · Nestvexa Svelte</title>
</svelte:head>

<h1>Prefetched page</h1>
<p data-testid="renders">Server renders: {renders}</p>
<Link href="/features">Back to features</Link>
