<script lang="ts">
  import { Link, usePage } from '@inertiajs/svelte';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { SharedProps } from '../../src/page-types';

  let { children }: { children?: Snippet } = $props();
  const page = usePage<SharedProps>();
  const root = $derived(page.props.root);
  const success = $derived.by(() => {
    const value = page.flash?.['success'];
    return typeof value === 'string' ? value : undefined;
  });
  onMount(() => {
    document.documentElement.dataset['hydrated'] = 'svelte';
  });
</script>

<header>
  <p data-testid="app-name">{page.props.appName} · {page.props.framework}</p>
  <nav aria-label="Admin">
    <Link href={root}>Dashboard</Link>
    <Link href={`${root}/users`}>Users</Link>
    <Link href={`${root}/users/create`}>New user</Link>
    <a href="/admin/react">React admin</a>
    <a href="/admin/vue">Vue admin</a>
    <a href="/">HBS home</a>
  </nav>
</header>
<main>
  {#if success}
    <p role="status" data-testid="flash">{success}</p>
  {/if}
  {@render children?.()}
</main>
