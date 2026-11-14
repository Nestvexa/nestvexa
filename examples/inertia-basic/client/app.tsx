import {
  Deferred,
  Link,
  createInertiaApp,
  router,
  useForm,
  usePage,
} from '@inertiajs/react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

interface User {
  readonly id: number;
  readonly name: string;
}

function Layout({ children }: { readonly children: ReactNode }) {
  const page = usePage<{
    appName: string;
    regions?: { readonly names: readonly string[]; readonly load: number };
  }>();
  const regions = page.props.regions;
  const success = page.flash['success'];
  return (
    <main>
      <nav aria-label="Main">
        <Link href="/">Home</Link> <Link href="/users">Users</Link>{' '}
        <Link href="/users/create">New user</Link>{' '}
        <Link href="/admin">Admin</Link> <Link href="/broken">Broken</Link>
      </nav>
      <p data-testid="app-name">{page.props.appName}</p>
      {regions ? (
        <p data-testid="regions">
          Regions: {regions.names.join(', ')} (load {regions.load})
        </p>
      ) : null}
      {typeof success === 'string' ? (
        <p role="status" data-testid="flash">
          {success}
        </p>
      ) : null}
      {children}
    </main>
  );
}

function Home({
  greeting,
  visits,
  stats,
  extra,
}: {
  readonly greeting: string;
  readonly visits: number;
  readonly stats?: { readonly users: number };
  readonly extra?: string;
}) {
  return (
    <Layout>
      <h1>{greeting}</h1>
      <p data-testid="visits">Visits: {visits}</p>
      <Deferred
        data="stats"
        fallback={<p data-testid="stats">Loading stats…</p>}
      >
        <p data-testid="stats">Users: {stats?.users}</p>
      </Deferred>
      <button type="button" onClick={() => router.reload({ only: ['extra'] })}>
        Load extra
      </button>
      {extra === undefined ? null : <p data-testid="extra">{extra}</p>}
    </Layout>
  );
}

function UsersIndex({ users }: { readonly users: readonly User[] }) {
  return (
    <Layout>
      <h1>Users</h1>
      <ul aria-label="Users">
        {users.map((user) => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </Layout>
  );
}

function UsersCreate() {
  const form = useForm({ name: '' });
  return (
    <Layout>
      <h1>Create user</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.post('/users');
        }}
      >
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          value={form.data.name}
          aria-invalid={form.errors.name ? 'true' : 'false'}
          aria-describedby={form.errors.name ? 'name-error' : undefined}
          onChange={(event) => form.setData('name', event.target.value)}
        />
        {form.errors.name ? (
          <p id="name-error" role="alert">
            {form.errors.name}
          </p>
        ) : null}
        <button type="submit" disabled={form.processing}>
          Save
        </button>
      </form>
    </Layout>
  );
}

function ErrorPage({
  status,
  message,
}: {
  readonly status: number;
  readonly message: string;
}) {
  return (
    <Layout>
      <h1>Error {status}</h1>
      <p data-testid="error-message">{message}</p>
    </Layout>
  );
}

const pages = {
  Home,
  ErrorPage,
  'Users/Index': UsersIndex,
  'Users/Create': UsersCreate,
} as const;

function isPage(name: string): name is keyof typeof pages {
  return Object.hasOwn(pages, name);
}

void createInertiaApp({
  resolve: (name) => {
    if (!isPage(name)) throw new Error(`Unknown page ${name}`);
    return pages[name];
  },
  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />);
  },
});
