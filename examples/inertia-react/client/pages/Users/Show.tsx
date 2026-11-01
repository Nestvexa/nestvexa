import { Head } from '@inertiajs/react';
import type { AppPages } from '../../../src/page-types';

export default function UsersShow({ user }: AppPages['Users/Show']) {
  return (
    <>
      <Head title={user.name} />
      <h1>{user.name}</h1>
      <dl>
        <dt>Email</dt>
        <dd data-testid="email">{user.email}</dd>
      </dl>
    </>
  );
}
