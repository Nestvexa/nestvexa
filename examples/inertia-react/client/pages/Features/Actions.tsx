import { Head, Link } from '@inertiajs/react';
import { useState } from 'react';
import type { FeaturePages } from '../../../src/page-types';
import { actionHooks } from '../../actions';

// A typed server action called from an Inertia page through the generated
// React hook: input, output and error field types come from the server's
// NotesActions.add signature. The board the page was rendered with is the
// hook's initial data, the optimistic value shows while the call is pending
// and is rolled back when the server rejects it.
export default function FeaturesActions({
  board,
}: FeaturePages['Features/Actions']) {
  const [text, setText] = useState('');
  const add = actionHooks.useNotesAdd({
    initialData: board,
    optimistic: (current, input) => ({
      total: (current?.total ?? 0) + 1,
      latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
    }),
    onSuccess: () => setText(''),
  });
  const issue = add.error?.issues.find((entry) => entry.path[0] === 'text');
  const shown = add.data ?? board;
  return (
    <>
      <Head title="Typed actions" />
      <h1>Typed server actions</h1>
      <p data-testid="notes-status" data-optimistic={String(add.optimistic)}>
        {add.status}: {shown.total} notes
      </p>
      <ul aria-label="Notes" data-testid="notes">
        {shown.latest.map((note, index) => (
          <li key={`${index}-${note}`}>{note}</li>
        ))}
      </ul>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add.run({ text });
        }}
      >
        <label htmlFor="note">Note</label>
        <input
          id="note"
          value={text}
          aria-invalid={issue ? 'true' : 'false'}
          aria-describedby={issue ? 'note-error' : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        {issue ? (
          <p id="note-error" className="field-error" role="alert">
            {issue.message}
          </p>
        ) : null}
        <button type="submit" disabled={add.pending}>
          Add note
        </button>
      </form>
      <p>
        <Link href="/features">Back to features</Link>
      </p>
    </>
  );
}
