<script lang="ts">
  import type { UsersShowProps } from '../../../src/page-types';

  let { user }: UsersShowProps = $props();
</script>

<svelte:head>
  <title>{user.name} · Nestvexa Svelte</title>
</svelte:head>

<h1>{user.name}</h1>
<dl>
  <dt>Email</dt>
  <dd data-testid="email">{user.email}</dd>
</dl>
