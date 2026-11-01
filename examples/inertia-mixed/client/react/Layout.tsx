import { Link } from '@inertiajs/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

export default function Layout({ children }: { readonly children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset['hydrated'] = 'react';
  }, []);
  return (
    <>
      <nav aria-label="Roots">
        <Link href="/react">React home</Link>{' '}
        <Link href="/react/about">React about</Link>{' '}
        <Link href="/vue">Vue root</Link>{' '}
        <Link href="/svelte">Svelte root</Link> <a href="/">HBS index</a>
      </nav>
      <main>{children}</main>
    </>
  );
}
