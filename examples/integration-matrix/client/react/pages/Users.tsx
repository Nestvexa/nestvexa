import { Head } from '@inertiajs/react';
import type { UsersProps } from '../../../src/page-types';

export default function Users({ users }: UsersProps) {
  return (
    <>
      <Head title="Users" />
      <h1>Users</h1>
      <ul aria-label="Users" data-testid="users">
        {users.map((user) => (
          <li key={user.id}>
            {user.name} ({user.email})
          </li>
        ))}
      </ul>
    </>
  );
}
