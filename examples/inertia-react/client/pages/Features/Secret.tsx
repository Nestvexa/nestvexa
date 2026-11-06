import { Head, Link, router } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesSecret({
  secret,
}: FeaturePages['Features/Secret']) {
  return (
    <>
      <Head title="Encrypted history" />
      <h1>Encrypted history</h1>
      <p data-testid="secret">{secret}</p>
      <p>
        <Link href="/features">Back to features</Link>
      </p>
      <button type="button" onClick={() => router.post('/features/forget')}>
        Forget history
      </button>
    </>
  );
}
