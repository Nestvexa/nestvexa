import { Head, Link } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesTarget({
  from,
}: FeaturePages['Features/Target']) {
  return (
    <>
      <Head title="Visit target" />
      <h1>Visit target</h1>
      <p data-testid="from">Reached via {from}</p>
      <Link href="/features">Back to features</Link>
    </>
  );
}
