import { Head, InfiniteScroll, router } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesScroll({
  items,
  notes,
}: FeaturePages['Features/Scroll']) {
  return (
    <>
      <Head title="Infinite scroll" />
      <h1>Infinite scroll</h1>
      <section aria-label="Merged notes">
        <ul data-testid="notes">
          {notes.map((note) => (
            <li key={note.id}>{note.text}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            router.reload({
              only: ['notes'],
              data: { notes: notes.length + 1 },
            })
          }
        >
          Load more notes
        </button>
      </section>
      <InfiniteScroll
        data="items"
        buffer={200}
        loading={() => <p role="status">Loading more items…</p>}
      >
        <ul aria-label="Items" data-testid="items">
          {items.data.map((item) => (
            <li key={item.id} className="tall-item">
              {item.label}
            </li>
          ))}
        </ul>
      </InfiniteScroll>
    </>
  );
}
