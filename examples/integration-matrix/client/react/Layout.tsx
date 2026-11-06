import { Link, usePage } from '@inertiajs/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { SharedProps } from '../../src/page-types';

export default function Layout({ children }: { readonly children: ReactNode }) {
  const page = usePage<SharedProps>();
  const success = page.flash['success'];
  const root = page.props.root;
  useEffect(() => {
    document.documentElement.dataset['hydrated'] = 'react';
  }, []);
  return (
    <>
      <header>
        <p data-testid="app-name">
          {page.props.appName} · {page.props.framework}
        </p>
        <nav aria-label="Admin">
          <Link href={root}>Dashboard</Link>{' '}
          <Link href={`${root}/users`}>Users</Link>{' '}
          <Link href={`${root}/users/create`}>New user</Link>{' '}
          <a href="/admin/vue">Vue admin</a>{' '}
          <a href="/admin/svelte">Svelte admin</a> <a href="/">HBS home</a>
        </nav>
      </header>
      <main>
        {typeof success === 'string' ? (
          <p role="status" data-testid="flash">
            {success}
          </p>
        ) : null}
        {children}
      </main>
    </>
  );
}
