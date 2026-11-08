<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { step, plans }: FeaturePages['Features/Once'] = $props();
</script>

<svelte:head>
  <title>Once props {step} · Nestvexa Svelte</title>
</svelte:head>

<h1>Once props: step {step}</h1>
<p data-testid="plans-token">Plans token {plans.token}</p>
<p>{plans.names.join(', ')}</p>
<Link href={step === 'a' ? '/features/once/b' : '/features/once/a'}>
  Go to step {step === 'a' ? 'b' : 'a'}
</Link>
