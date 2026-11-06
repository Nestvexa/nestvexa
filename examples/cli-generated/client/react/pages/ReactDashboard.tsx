import { Head } from '@inertiajs/react';

export default function ReactDashboard({ title }: { readonly title: string }) {
  return (
    <>
      <Head title={title} />
      <h1>{title}</h1>
      <p>Rendered by React through Inertia.</p>
    </>
  );
}
