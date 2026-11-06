import { Head, usePoll } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesPoll({ tick }: FeaturePages['Features/Poll']) {
  const { stop, polling } = usePoll(400, { only: ['tick'] });
  return (
    <>
      <Head title="Polling" />
      <h1>Polling</h1>
      <p data-testid="tick">Tick {tick}</p>
      <p data-testid="polling">{polling ? 'Polling' : 'Stopped'}</p>
      <button type="button" onClick={stop}>
        Stop polling
      </button>
    </>
  );
}
