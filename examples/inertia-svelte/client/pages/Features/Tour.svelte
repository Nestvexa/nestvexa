<script lang="ts">
  import { Link, router } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  let { title }: FeaturePages['Features/Tour'] = $props();
</script>

<svelte:head>
  <title>{title} · Nestvexa Svelte</title>
</svelte:head>

<h1>{title}</h1>
<nav aria-label="Tour pages" class="stack">
  <Link href="/features/slow" component="Features/Slow">Instant visit</Link>
  <Link href="/features/target?from=transition" viewTransition>
    View transition
  </Link>
  <Link href="/features/remember">Remembered state</Link>
  <Link href="/features/once/a">Once props</Link>
  <Link href="/features/todos">Optimistic todos</Link>
  <Link href="/features/long/1">Long pages</Link>
  <Link href="/features/slow">Slow page</Link>
  <Link href="/features/actions">Typed actions</Link>
</nav>
<h2>Manual visits</h2>
<div class="stack">
  <button
    type="button"
    onclick={() =>
      router.visit('/features/target', { data: { from: 'router.visit' } })}
  >
    Visit with router.visit
  </button>
  <button
    type="button"
    onclick={() => router.post('/features/ping', { source: 'router.post' })}
  >
    Post with router.post
  </button>
  <Link
    href="/features/ping"
    method="post"
    as="button"
    data={{ source: 'link.post' }}
  >
    Post with a link
  </Link>
  <button
    type="button"
    onclick={() => router.visit('/features/slow', { showProgress: false })}
  >
    Quiet slow visit
  </button>
</div>
