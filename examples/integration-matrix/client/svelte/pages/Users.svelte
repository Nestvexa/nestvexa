<script lang="ts">
  import type { UsersProps } from '../../../src/page-types';

  let { users }: UsersProps = $props();
</script>

<svelte:head>
  <title>Users · Svelte admin</title>
</svelte:head>

<h1>Users</h1>
<ul aria-label="Users" data-testid="users">
  {#each users as user (user.id)}
    <li>{user.name} ({user.email})</li>
  {/each}
</ul>
