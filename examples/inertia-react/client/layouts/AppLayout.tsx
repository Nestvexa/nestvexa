import { Link, usePage } from '@inertiajs/react';
import { ErrorBoundary } from '@nestvexa/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { SharedProps } from '../../src/page-types';

function useLayoutInstance(): string {
  // Assigned once per client mount (after hydration, so server and client
  // markup agree): unchanged across Inertia visits proves the layout persists.
  const [id, setId] = useState('server');
  useEffect(() => {
    setId(Math.random().toString(36).slice(2, 10));
    document.documentElement.dataset['hydrated'] = 'true';
  }, []);
  return id;
}

export default function AppLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const page = usePage<SharedProps>();
  const instance = useLayoutInstance();
  const success = page.flash['success'];
  return (
    <>
      <header className="shell">
        <p className="brand" data-testid="app-name">
          {page.props.appName} · {page.props.framework}
        </p>
        <nav aria-label="Main">
          <Link href="/">Home</Link>
          <Link href="/users">Users</Link>
          <Link href="/uploads">Uploads</Link>
          <Link href="/features">Features</Link>
          <Link href="/broken">Broken page</Link>
        </nav>
      </header>
      <main className="shell" data-layout-instance={instance}>
        {typeof success === 'string' ? (
          <p role="status" className="flash" data-testid="flash">
            {success}
          </p>
        ) : null}
        <ErrorBoundary
          resetKey={page.url}
          fallback={
            <div role="alert" className="error">
              <h1>Something went wrong</h1>
              <p>This page failed to render. Other pages still work.</p>
            </div>
          }
        >
          {children}
        </ErrorBoundary>
      </main>
    </>
  );
}
