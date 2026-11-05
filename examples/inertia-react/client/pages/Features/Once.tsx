import { Head, Link } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesOnce({
  step,
  plans,
}: FeaturePages['Features/Once']) {
  return (
    <>
      <Head title={`Once props ${step}`} />
      <h1>Once props: step {step}</h1>
      <p data-testid="plans-token">Plans token {plans.token}</p>
      <p>{plans.names.join(', ')}</p>
      <Link href={step === 'a' ? '/features/once/b' : '/features/once/a'}>
        Go to step {step === 'a' ? 'b' : 'a'}
      </Link>
    </>
  );
}
