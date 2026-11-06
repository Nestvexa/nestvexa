import { Deferred, Head, router } from '@inertiajs/react';
import type { DashboardProps } from '../../../src/page-types';

export default function Dashboard({
  heading,
  framework,
  stats,
  extra,
}: DashboardProps) {
  return (
    <>
      <Head title="Dashboard" />
      <h1>{heading}</h1>
      <p data-testid="framework">Rendered by {framework}</p>
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
    </>
  );
}
