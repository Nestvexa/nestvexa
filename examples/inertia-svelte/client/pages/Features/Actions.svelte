<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import { untrack } from 'svelte';
  import type { FeaturePages } from '../../../src/page-types';
  import { actionStores } from '../../actions';

  // A typed server action called from an Inertia page through the generated
  // Svelte store: input, output and error field types come from the server's
  // NotesActions.add signature. The board the page was rendered with is the
  // initial data, the optimistic value shows while the call is pending and is
  // rolled back when the server rejects it.
  let { board }: FeaturePages['Features/Actions'] = $props();
  let text = $state('');
  const add = actionStores.notesAdd({
    // Created once, with the board the page was rendered with.
    initialData: untrack(() => board),
    optimistic: (current, input) => ({
      total: (current?.total ?? 0) + 1,
      latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
    }),
    onSuccess: () => {
      text = '';
    },
  });
  const issue = $derived(
    $add.error?.issues.find((entry) => entry.path[0] === 'text'),
  );
  const shown = $derived($add.data ?? board);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    void add.run({ text });
  }
</script>

<svelte:head>
  <title>Typed actions · Nestvexa Svelte</title>
</svelte:head>

<h1>Typed server actions</h1>
<p data-testid="notes-status" data-optimistic={String($add.optimistic)}>
  {$add.status}: {shown.total} notes
</p>
<ul aria-label="Notes" data-testid="notes">
  {#each shown.latest as note, index (`${index}-${note}`)}
    <li>{note}</li>
  {/each}
</ul>
<form novalidate onsubmit={submit}>
  <label for="note">Note</label>
  <input
    id="note"
    bind:value={text}
    aria-invalid={issue ? 'true' : 'false'}
    aria-describedby={issue ? 'note-error' : undefined}
  />
  {#if issue}
    <p id="note-error" class="field-error" role="alert">{issue.message}</p>
  {/if}
  <button type="submit" disabled={$add.pending}>Add note</button>
</form>
<p>
  <Link href="/features/tour">Back to features</Link>
</p>
