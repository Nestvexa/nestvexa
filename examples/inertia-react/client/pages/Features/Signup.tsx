import { Head, useForm } from '@inertiajs/react';

// useForm(method, url, data) enables Precognition: validate('field') sends a
// validation-only request (`Precognition: true`, `Precognition-Validate-Only`)
// that the @Precognitive route answers with 204 or 422 without saving.
export default function FeaturesSignup() {
  const form = useForm('post', '/features/signup', { name: '', email: '' });
  const field = (name: 'name' | 'email', label: string, type = 'text') => (
    <>
      <label htmlFor={`signup-${name}`}>{label}</label>
      <input
        id={`signup-${name}`}
        name={name}
        type={type}
        value={form.data[name]}
        aria-invalid={form.invalid(name) ? 'true' : 'false'}
        aria-describedby={
          form.errors[name] ? `signup-${name}-error` : undefined
        }
        onChange={(event) => form.setData(name, event.target.value)}
        onBlur={() => form.validate(name)}
      />
      {form.errors[name] ? (
        <p id={`signup-${name}-error`} className="field-error" role="alert">
          {form.errors[name]}
        </p>
      ) : null}
      {form.valid(name) ? (
        <p data-testid={`signup-${name}-valid`}>Looks good</p>
      ) : null}
    </>
  );
  return (
    <>
      <Head title="Precognition signup" />
      <h1>Precognition signup</h1>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.submit();
        }}
      >
        {field('name', 'Name')}
        {field('email', 'Email', 'email')}
        <p data-testid="validating" aria-live="polite">
          {form.validating ? 'Validating…' : ''}
        </p>
        <button type="submit" disabled={form.processing}>
          Sign up
        </button>
      </form>
    </>
  );
}
