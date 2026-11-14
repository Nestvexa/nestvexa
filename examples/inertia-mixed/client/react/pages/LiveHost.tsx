import { router } from '@inertiajs/react';
import { createLiveClient } from '@nestvexa/client';
import { useEffect, useRef, useState } from 'react';

/**
 * Isolated Live element inside an Inertia page (VISION-017). React owns the
 * page and an empty host `<div>`; the Live client owns everything inside the
 * host. React never renders children into it, so its reconciliation cannot
 * touch Live markup, and the Live client is scoped to the host element, so
 * its morphs and listeners cannot reach React's DOM.
 */
function LiveIsland({ html }: { readonly html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    // `html` is the server-rendered, signed mount of a registered component
    // (a trusted prop of this page, never user input).
    element.innerHTML = html;
    const client = createLiveClient({
      root: element,
      onError: (error) => {
        element.dataset['liveError'] = error.message;
      },
    });
    client.mount();
    element.dataset['liveMounted'] = 'true';
    return () => {
      // Inertia navigation away (or a new mount from the server) disposes the
      // client first: listeners are removed and in-flight requests aborted.
      client.dispose();
      delete element.dataset['liveMounted'];
      element.replaceChildren();
    };
  }, [html]);
  return <div ref={host} id="live-host" data-testid="live-host" />;
}

export default function LiveHost({
  heading,
  live,
  stamp,
}: {
  readonly heading: string;
  readonly live: string;
  readonly stamp: number;
}) {
  // React-owned state that Live updates must never reset.
  const [clicks, setClicks] = useState(0);
  return (
    <>
      <h1>{heading}</h1>
      <section aria-label="React state">
        <p>
          React clicks: <output id="react-clicks">{clicks}</output>
        </p>
        <button type="button" onClick={() => setClicks((value) => value + 1)}>
          React click
        </button>
        <p>
          Server stamp: <output id="stamp">{stamp}</output>
        </p>
        <button
          type="button"
          onClick={() => router.reload({ only: ['stamp'] })}
        >
          Reload stamp
        </button>
      </section>
      <section aria-label="Live counter">
        <LiveIsland html={live} />
      </section>
    </>
  );
}
