<script lang="ts">
  import type { FeaturePages } from '../../../src/page-types';

  // With an instant visit this component renders from shared props alone
  // while the server is still answering; `loaded` arrives with the real
  // response.
  let { loaded }: FeaturePages['Features/Slow'] = $props();
</script>

<svelte:head>
  <title>Slow page · Nestvexa Svelte</title>
</svelte:head>

<h1>Slow page</h1>
<p data-testid="loaded">{loaded ?? 'Waiting for the server…'}</p>
