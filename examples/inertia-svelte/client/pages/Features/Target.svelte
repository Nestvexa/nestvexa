<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { from }: FeaturePages['Features/Target'] = $props();
</script>

<svelte:head>
  <title>Visit target · Nestvexa Svelte</title>
</svelte:head>

<h1>Visit target</h1>
<p data-testid="from">Reached via {from}</p>
<Link href="/features/tour">Back to features</Link>
