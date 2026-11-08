import { Head, Link } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

// Scroll management by the official client: visits reset the window and every
// `scroll-region` element to the top, `preserveScroll` keeps the position,
// back/forward restores both from the history entry, and a `#hash` scrolls to
// its anchor.
export default function FeaturesLong({
  page,
  next,
}: FeaturePages['Features/Long']) {
  return (
    <>
      <Head title={`Long page ${page}`} />
      <h1>Long page {page}</h1>
      <div
        scroll-region=""
        className="scroll-region"
        data-testid="region"
        role="region"
        aria-label="Scroll region"
      >
        <div className="scroll-region-content">Region content</div>
      </div>
      <div className="long-spacer" aria-hidden="true" />
      <h2 id="anchor">Anchor on page {page}</h2>
      <div className="long-spacer" aria-hidden="true" />
      <nav aria-label="Long pages" className="stack">
        <Link href={`/features/long/${next}`}>Next long page</Link>
        <Link href={`/features/long/${next}`} preserveScroll>
          Next, preserving scroll
        </Link>
        <Link href={`/features/long/${next}#anchor`}>Next, to the anchor</Link>
        <Link href="/features">Back to features</Link>
      </nav>
    </>
  );
}
