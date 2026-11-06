import { Head, WhenVisible } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesLazy({ below }: FeaturePages['Features/Lazy']) {
  return (
    <>
      <Head title="Load when visible" />
      <h1>Load when visible</h1>
      <div className="spacer" aria-hidden="true" />
      <WhenVisible
        data="below"
        buffer={0}
        fallback={<p data-testid="below">Not loaded yet</p>}
      >
        <p data-testid="below">{below}</p>
      </WhenVisible>
    </>
  );
}
