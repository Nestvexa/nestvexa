<script setup lang="ts">
import { Link, usePage } from '@inertiajs/vue3';
import { computed, onMounted } from 'vue';
import type { SharedProps } from '../../src/page-types';

const page = usePage<SharedProps>();
const root = computed(() => page.props.root);
const success = computed(() => {
  const value = page.flash['success'];
  return typeof value === 'string' ? value : undefined;
});
onMounted(() => {
  document.documentElement.dataset['hydrated'] = 'vue';
});
</script>

<template>
  <header>
    <p data-testid="app-name">
      {{ page.props.appName }} · {{ page.props.framework }}
    </p>
    <nav aria-label="Admin">
      <Link :href="root">Dashboard</Link>
      <Link :href="`${root}/users`">Users</Link>
      <Link :href="`${root}/users/create`">New user</Link>
      <a href="/admin/react">React admin</a>
      <a href="/admin/svelte">Svelte admin</a>
      <a href="/">HBS home</a>
    </nav>
  </header>
  <main>
    <p v-if="success" role="status" data-testid="flash">{{ success }}</p>
    <slot />
  </main>
</template>
