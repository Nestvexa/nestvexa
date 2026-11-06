import { Head } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

// With an instant visit this component renders from shared props alone while
// the server is still answering; `loaded` arrives with the real response.
export default function FeaturesSlow({
  loaded,
}: FeaturePages['Features/Slow']) {
  return (
    <>
      <Head title="Slow page" />
      <h1>Slow page</h1>
      <p data-testid="loaded">{loaded ?? 'Waiting for the server…'}</p>
    </>
  );
}
