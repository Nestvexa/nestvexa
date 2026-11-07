<script setup lang="ts">
import { Link, usePage } from '@inertiajs/vue3';
import { computed, onMounted } from 'vue';
import type { SharedProps } from './types';

const page = usePage<SharedProps>();
const success = computed(() => {
  const value = page.flash['success'];
  return typeof value === 'string' ? value : undefined;
});
onMounted(() => {
  document.documentElement.dataset['hydrated'] = 'vue';
});
</script>

<template>
  <header class="site-header">
    <p class="brand">{{ page.props.appName }} · {{ page.props.workspace }}</p>
    <nav aria-label="Main">
      <a href="/app">Dashboard</a>
      <a href="/app/tasks">Tasks</a>
      <a href="/app/profile">Profile</a>
      <Link href="/insights">Analytics</Link>
      <Link href="/insights/goals">Goals</Link>
      <a href="/app/outbox">Mail outbox</a>
    </nav>
    <p class="who">
      Signed in as {{ page.props.userName }} ({{ page.props.role }})
    </p>
  </header>
  <main id="main">
    <p v-if="success" role="status" class="notice" data-testid="flash">
      {{ success }}
    </p>
    <slot />
  </main>
</template>
