<script lang="ts">
  import { Deferred, Link, router } from '@inertiajs/svelte';
  import type { HomeProps } from '../../src/page-types';

  let { greeting, visits, renderedBy, stats, extra }: HomeProps = $props();
</script>

<svelte:head>
  <title>Home · Nestvexa Svelte</title>
</svelte:head>

<h1>{greeting}</h1>
<p data-testid="visits">Visits this session: {visits}</p>
<p>Props come from the {renderedBy}; this markup was rendered on the server.</p>
<Deferred data="stats">
  {#snippet fallback()}
    <p data-testid="stats">Loading stats…</p>
  {/snippet}
  <p data-testid="stats">Users: {stats?.users}</p>
</Deferred>
<button type="button" onclick={() => router.reload({ only: ['extra'] })}>
  Load extra
</button>
{#if extra !== undefined}
  <p data-testid="extra">{extra}</p>
{/if}
<p><Link href="/users/create">Create a user</Link></p>
