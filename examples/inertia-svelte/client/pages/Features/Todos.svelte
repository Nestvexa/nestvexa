<script lang="ts">
  import { router, usePage } from '@inertiajs/svelte';
  import type { FeaturePages, SharedProps } from '../../../src/page-types';

  type TodosProps = FeaturePages['Features/Todos'];

  let { todos }: TodosProps = $props();
  const page = usePage<SharedProps>();
  let title = $state('');

  function add(event: SubmitEvent): void {
    event.preventDefault();
    const text = title;
    router.post(
      '/features/todos',
      { title: text },
      {
        preserveScroll: true,
        // Applied immediately; rolled back by the client if the visit fails.
        optimistic: (props) => ({
          todos: [
            ...(props['todos'] as TodosProps['todos']),
            { id: -1, title: text, pending: true },
          ],
        }),
        onSuccess: () => {
          title = '';
        },
      },
    );
  }
</script>

<svelte:head>
  <title>Optimistic todos · Nestvexa Svelte</title>
</svelte:head>

<h1>Optimistic todos</h1>
<ul aria-label="Todos" data-testid="todos">
  {#each todos as todo (todo.id)}
    <li data-pending={todo.pending ? 'true' : 'false'}>
      {todo.title}{todo.pending ? ' (saving…)' : ''}
    </li>
  {/each}
</ul>
<form novalidate onsubmit={add}>
  <label for="title">Title</label>
  <input
    id="title"
    bind:value={title}
    aria-invalid={page.props.errors['title'] ? 'true' : 'false'}
    aria-describedby={page.props.errors['title'] ? 'title-error' : undefined}
  />
  {#if page.props.errors['title']}
    <p id="title-error" class="field-error" role="alert">
      {page.props.errors['title']}
    </p>
  {/if}
  <button type="submit">Add todo</button>
</form>
