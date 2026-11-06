import { Head, router, usePage } from '@inertiajs/react';
import { useState } from 'react';
import type { FeaturePages, SharedProps } from '../../../src/page-types';

type TodosProps = FeaturePages['Features/Todos'];

export default function FeaturesTodos({ todos }: TodosProps) {
  const { errors } = usePage<SharedProps>().props;
  const [title, setTitle] = useState('');
  const add = () =>
    router.post(
      '/features/todos',
      { title },
      {
        preserveScroll: true,
        // Applied immediately; rolled back by the client if the visit fails.
        optimistic: (props) => ({
          todos: [
            ...(props['todos'] as TodosProps['todos']),
            { id: -1, title, pending: true },
          ],
        }),
        onSuccess: () => setTitle(''),
      },
    );
  return (
    <>
      <Head title="Optimistic todos" />
      <h1>Optimistic todos</h1>
      <ul aria-label="Todos" data-testid="todos">
        {todos.map((todo) => (
          <li key={todo.id} data-pending={todo.pending ? 'true' : 'false'}>
            {todo.title}
            {todo.pending ? ' (saving…)' : ''}
          </li>
        ))}
      </ul>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label htmlFor="title">Title</label>
        <input
          id="title"
          value={title}
          aria-invalid={errors['title'] ? 'true' : 'false'}
          aria-describedby={errors['title'] ? 'title-error' : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        {errors['title'] ? (
          <p id="title-error" className="field-error" role="alert">
            {errors['title']}
          </p>
        ) : null}
        <button type="submit">Add todo</button>
      </form>
    </>
  );
}
