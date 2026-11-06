<script lang="ts">
  import { useForm } from '@inertiajs/svelte';
  import type { CreateUserProps } from '../../../src/page-types';

  let { root }: CreateUserProps = $props();
  const form = useForm({ name: '', email: '' });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    form.post(`${root}/users`);
  }
</script>

<svelte:head>
  <title>Create user · Svelte admin</title>
</svelte:head>

<h1>Create user</h1>
<form novalidate onsubmit={submit}>
  <label for="name">Name</label>
  <input
    id="name"
    name="name"
    autocomplete="name"
    bind:value={form.name}
    aria-invalid={form.errors.name ? 'true' : 'false'}
    aria-describedby={form.errors.name ? 'name-error' : undefined}
  />
  {#if form.errors.name}
    <p id="name-error" role="alert">{form.errors.name}</p>
  {/if}
  <label for="email">Email</label>
  <input
    id="email"
    name="email"
    type="email"
    autocomplete="email"
    bind:value={form.email}
    aria-invalid={form.errors.email ? 'true' : 'false'}
    aria-describedby={form.errors.email ? 'email-error' : undefined}
  />
  {#if form.errors.email}
    <p id="email-error" role="alert">{form.errors.email}</p>
  {/if}
  <button type="submit" disabled={form.processing}>Save</button>
</form>
