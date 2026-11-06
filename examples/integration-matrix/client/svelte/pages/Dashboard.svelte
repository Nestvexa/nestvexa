<script lang="ts">
  import { Deferred, router } from '@inertiajs/svelte';
  import type { DashboardProps } from '../../../src/page-types';

  let { heading, framework, stats, extra }: DashboardProps = $props();
</script>

<svelte:head>
  <title>Dashboard · Svelte admin</title>
</svelte:head>

<h1>{heading}</h1>
<p data-testid="framework">Rendered by {framework}</p>
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
