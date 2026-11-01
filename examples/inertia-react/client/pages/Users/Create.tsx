import { Head, useForm } from '@inertiajs/react';

export default function UsersCreate() {
  const form = useForm({ name: '', email: '' });
  return (
    <>
      <Head title="Create user" />
      <h1>Create user</h1>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.post('/users');
        }}
      >
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          autoComplete="name"
          value={form.data.name}
          aria-invalid={form.errors.name ? 'true' : 'false'}
          aria-describedby={form.errors.name ? 'name-error' : undefined}
          onChange={(event) => form.setData('name', event.target.value)}
        />
        {form.errors.name ? (
          <p id="name-error" className="field-error" role="alert">
            {form.errors.name}
          </p>
        ) : null}
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={form.data.email}
          aria-invalid={form.errors.email ? 'true' : 'false'}
          aria-describedby={form.errors.email ? 'email-error' : undefined}
          onChange={(event) => form.setData('email', event.target.value)}
        />
        {form.errors.email ? (
          <p id="email-error" className="field-error" role="alert">
            {form.errors.email}
          </p>
        ) : null}
        <button type="submit" disabled={form.processing}>
          Save
        </button>
      </form>
    </>
  );
}
