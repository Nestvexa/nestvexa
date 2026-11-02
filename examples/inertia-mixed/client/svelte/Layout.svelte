<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
  onMount(() => {
    document.documentElement.dataset['hydrated'] = 'svelte';
  });
</script>

<nav aria-label="Roots">
  <Link href="/svelte">Svelte home</Link>
  <Link href="/svelte/about">Svelte about</Link>
  <Link href="/react">React root</Link>
  <Link href="/vue">Vue root</Link>
  <a href="/">HBS index</a>
</nav>
<main>{@render children?.()}</main>
