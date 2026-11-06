<script lang="ts">
  import { Link, usePage } from '@inertiajs/svelte';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { SharedProps } from '../../src/page-types';

  let { children }: { children?: Snippet } = $props();
  const page = usePage<SharedProps>();
  // Assigned once per client mount (after hydration, so server and client
  // markup agree): unchanged across Inertia visits proves the layout persists.
  let instance = $state('server');
  onMount(() => {
    instance = Math.random().toString(36).slice(2, 10);
    document.documentElement.dataset['hydrated'] = 'true';
  });
  const success = $derived.by(() => {
    const value = page.flash?.['success'];
    return typeof value === 'string' ? value : undefined;
  });
</script>

<header class="shell">
  <p class="brand" data-testid="app-name">
    {page.props.appName} · {page.props.framework}
  </p>
  <nav aria-label="Main">
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <Link href="/features">Features</Link>
    <Link href="/broken">Broken page</Link>
  </nav>
</header>
<main class="shell" data-layout-instance={instance}>
  {#if success}
    <p role="status" class="flash" data-testid="flash">{success}</p>
  {/if}
  <!-- Keyed by URL so a failed boundary resets on the next Inertia visit. -->
  {#key page.url}
    <svelte:boundary>
      {@render children?.()}
      {#snippet failed()}
        <div role="alert" class="error">
          <h1>Something went wrong</h1>
          <p>This page failed to render. Other pages still work.</p>
        </div>
      {/snippet}
    </svelte:boundary>
  {/key}
</main>
