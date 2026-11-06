import { Head, Link } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesPrefetched({
  renders,
}: FeaturePages['Features/Prefetched']) {
  return (
    <>
      <Head title="Prefetched" />
      <h1>Prefetched page</h1>
      <p data-testid="renders">Server renders: {renders}</p>
      <Link href="/features">Back to features</Link>
    </>
  );
}
