import { Head, Link } from '@inertiajs/react';
import type { AppPages } from '../../../src/page-types';

export default function UsersIndex({ users }: AppPages['Users/Index']) {
  return (
    <>
      <Head title="Users" />
      <h1>Users</h1>
      <ul aria-label="Users">
        {users.map((user) => (
          <li key={user.id}>
            <Link href={`/users/${user.id}`}>{user.name}</Link>
          </li>
        ))}
      </ul>
    </>
  );
}
