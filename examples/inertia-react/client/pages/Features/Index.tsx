import { Head, Link, router } from '@inertiajs/react';
import type { FeaturePages } from '../../../src/page-types';

export default function FeaturesIndex({
  title,
}: FeaturePages['Features/Index']) {
  return (
    <>
      <Head title={title} />
      <h1>{title}</h1>
      <nav aria-label="Feature pages" className="stack">
        <Link href="/features/prefetched" prefetch="hover" cacheFor="1m">
          Prefetched page
        </Link>
        <Link href="/features/slow" component="Features/Slow">
          Instant visit
        </Link>
        <Link href="/features/target?from=transition" viewTransition>
          View transition
        </Link>
        <Link href="/features/poll">Polling</Link>
        <Link href="/features/scroll">Infinite scroll</Link>
        <Link href="/features/lazy">Load when visible</Link>
        <Link href="/features/remember">Remembered state</Link>
        <Link href="/features/once/a">Once props</Link>
        <Link href="/features/secret">Encrypted history</Link>
        <Link href="/features/todos">Optimistic todos</Link>
        <Link href="/features/signup">Precognition signup</Link>
        <Link href="/features/large">Large payload</Link>
        <Link href="/features/long/1">Long pages</Link>
        <Link href="/features/slow">Slow page</Link>
        <Link href="/features/actions">Typed actions</Link>
      </nav>
      <h2>Manual visits</h2>
      <div className="stack">
        <button
          type="button"
          onClick={() =>
            router.visit('/features/target', { data: { from: 'router.visit' } })
          }
        >
          Visit with router.visit
        </button>
        <button
          type="button"
          onClick={() =>
            router.post('/features/ping', { source: 'router.post' })
          }
        >
          Post with router.post
        </button>
        <Link
          href="/features/ping"
          method="post"
          as="button"
          data={{ source: 'link.post' }}
        >
          Post with a link
        </Link>
        <button
          type="button"
          onClick={() =>
            router.visit('/features/slow', { showProgress: false })
          }
        >
          Quiet slow visit
        </button>
      </div>
    </>
  );
}
