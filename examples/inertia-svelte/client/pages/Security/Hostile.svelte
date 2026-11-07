<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { SecurityHostileProps } from '../../../src/page-types';
  import { safeHref } from '../../safe-href';

  // Every prop is hostile (see src/hostile.ts); each binding must render inert.
  let { payloads, links }: SecurityHostileProps = $props();
</script>

<svelte:head>
  <title>{payloads[0] ?? ''} · Nestvexa Svelte</title>
</svelte:head>

<h1>Hostile page props</h1>
<!-- An Inertia visit: the props arrive as JSON and the page renders again. -->
<Link href="/__test/hostile" data-testid="revisit">Load again</Link>
<ul aria-label="Payloads">
  {#each payloads as payload, index (index)}
    <li data-testid="payload" title={payload} data-payload={payload}>
      {payload}
    </li>
  {/each}
</ul>
<ul aria-label="Links">
  {#each links as link, index (index)}
    <li>
      <a data-testid="link" href={safeHref(link)} data-raw={link}>{link}</a>
    </li>
  {/each}
</ul>
