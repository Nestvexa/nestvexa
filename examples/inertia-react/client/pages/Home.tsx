import { Deferred, Head, Link, router } from '@inertiajs/react';
import type { AppPages } from '../../src/page-types';

export default function Home({
  greeting,
  visits,
  renderedBy,
  stats,
  extra,
}: AppPages['Home']) {
  return (
    <>
      <Head title="Home" />
      <h1>{greeting}</h1>
      <p data-testid="visits">Visits this session: {visits}</p>
      <p>
        Props come from the {renderedBy}; this markup was rendered on the
        server.
      </p>
      <Deferred
        data="stats"
        fallback={<p data-testid="stats">Loading stats…</p>}
      >
        <p data-testid="stats">Users: {stats?.users}</p>
      </Deferred>
      <button type="button" onClick={() => router.reload({ only: ['extra'] })}>
        Load extra
      </button>
      {extra === undefined ? null : <p data-testid="extra">{extra}</p>}
      <p>
        <Link href="/users/create">Create a user</Link>
      </p>
    </>
  );
}
