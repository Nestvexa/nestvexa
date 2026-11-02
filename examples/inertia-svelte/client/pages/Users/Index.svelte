<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { UsersIndexProps } from '../../../src/page-types';

  let { users }: UsersIndexProps = $props();
</script>

<svelte:head>
  <title>Users · Nestvexa Svelte</title>
</svelte:head>

<h1>Users</h1>
<ul aria-label="Users">
  {#each users as user (user.id)}
    <li><Link href={`/users/${user.id}`}>{user.name}</Link></li>
  {/each}
</ul>
