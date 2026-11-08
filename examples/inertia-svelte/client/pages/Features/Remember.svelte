<script lang="ts">
  import { Link, useForm, useRemember } from '@inertiajs/svelte';

  // Both are stored in the history entry by the official client and restored
  // when the user navigates back to this page.
  const note = useRemember({ draft: '' }, 'Features/Remember:draft');
  const form = useForm('Features/Remember:form', { topic: '' });
</script>

<svelte:head>
  <title>Remembered state · Nestvexa Svelte</title>
</svelte:head>

<h1>Remembered state</h1>
<label for="draft">Draft note</label>
<input id="draft" bind:value={note.draft} />
<label for="topic">Form topic</label>
<input id="topic" bind:value={form.topic} />
<p>
  <Link href="/features/tour">Back to features</Link>
</p>
