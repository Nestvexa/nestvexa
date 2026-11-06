import { Head } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

// Receives a multi-megabyte props payload; renders a summary instead of every
// row so the test measures transport and parsing, not DOM size.
export default function FeaturesLarge({
  rows,
}: FeaturePages['Features/Large']) {
  const last = rows[rows.length - 1];
  const checksum = rows.reduce((total, row) => total + row.id, 0);
  return (
    <>
      <Head title="Large payload" />
      <h1>Large payload</h1>
      <p data-testid="row-count">Rows: {rows.length}</p>
      <p data-testid="row-checksum">Checksum: {checksum}</p>
      <p data-testid="row-last">
        {last ? `${last.name} · ${last.email}` : 'No rows'}
      </p>
      <p data-testid="row-note">{rows[0]?.note}</p>
    </>
  );
}
