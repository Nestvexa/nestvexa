import { Head, Link, useForm, useRemember } from '@inertiajs/react';

export default function FeaturesRemember() {
  // Both are stored in the history entry by the official client and restored
  // when the user navigates back to this page.
  const [draft, setDraft] = useRemember('', 'Features/Remember:draft');
  const form = useForm('Features/Remember:form', { topic: '' });
  return (
    <>
      <Head title="Remembered state" />
      <h1>Remembered state</h1>
      <label htmlFor="draft">Draft note</label>
      <input
        id="draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <label htmlFor="topic">Form topic</label>
      <input
        id="topic"
        value={form.data.topic}
        onChange={(event) => form.setData('topic', event.target.value)}
      />
      <p>
        <Link href="/features">Back to features</Link>
      </p>
    </>
  );
}
