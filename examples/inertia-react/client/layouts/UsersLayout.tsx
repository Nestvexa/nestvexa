import { Link } from '@inertiajs/react';
import type { ReactNode } from 'react';

/** Nested persistent layout for the users section. */
export default function UsersLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <section className="section" aria-label="Users section">
      <nav aria-label="Users">
        <Link href="/users">All users</Link>
        <Link href="/users/create">New user</Link>
      </nav>
      {children}
    </section>
  );
}
