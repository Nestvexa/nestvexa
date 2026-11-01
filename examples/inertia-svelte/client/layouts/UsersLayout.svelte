<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<section class="section" aria-label="Users section">
  <nav aria-label="Users">
    <Link href="/users">All users</Link>
    <Link href="/users/create">New user</Link>
  </nav>
  {@render children?.()}
</section>
