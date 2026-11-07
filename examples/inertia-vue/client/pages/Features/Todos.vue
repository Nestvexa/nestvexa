<script setup lang="ts">
import { Head, router, usePage } from '@inertiajs/vue3';
import { ref } from 'vue';
import type { FeaturePages, SharedProps } from '../../../src/page-types';

type TodosProps = FeaturePages['Features/Todos'];

defineProps<TodosProps>();
const page = usePage<SharedProps>();
const title = ref('');

function add(): void {
  const text = title.value;
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
        title.value = '';
      },
    },
  );
}
</script>

<template>
  <Head title="Optimistic todos" />
  <h1>Optimistic todos</h1>
  <ul aria-label="Todos" data-testid="todos">
    <li
      v-for="todo in todos"
      :key="todo.id"
      :data-pending="todo.pending ? 'true' : 'false'"
    >
      {{ todo.title }}{{ todo.pending ? ' (saving…)' : '' }}
    </li>
  </ul>
  <form novalidate @submit.prevent="add">
    <label for="title">Title</label>
    <input
      id="title"
      v-model="title"
      :aria-invalid="page.props.errors['title'] ? 'true' : 'false'"
      :aria-describedby="page.props.errors['title'] ? 'title-error' : undefined"
    />
    <p
      v-if="page.props.errors['title']"
      id="title-error"
      class="field-error"
      role="alert"
    >
      {{ page.props.errors['title'] }}
    </p>
    <button type="submit">Add todo</button>
  </form>
</template>
