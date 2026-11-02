<script setup lang="ts">
import { Link, usePage } from '@inertiajs/vue3';
import { ErrorBoundary } from '@nestvexa/vue';
import { computed, onMounted, ref } from 'vue';
import type { SharedProps } from '../../src/page-types';

const page = usePage<SharedProps>();
// Assigned once per client mount (after hydration, so server and client markup
// agree): unchanged across Inertia visits proves the layout persists.
const instance = ref('server');
onMounted(() => {
  instance.value = Math.random().toString(36).slice(2, 10);
  document.documentElement.dataset['hydrated'] = 'true';
});
const success = computed(() => {
  const value = page.flash['success'];
  return typeof value === 'string' ? value : undefined;
});
</script>

<template>
  <header class="shell">
    <p class="brand" data-testid="app-name">
      {{ page.props.appName }} · {{ page.props.framework }}
    </p>
    <nav aria-label="Main">
      <Link href="/">Home</Link>
      <Link href="/users">Users</Link>
      <Link href="/broken">Broken page</Link>
    </nav>
  </header>
  <main class="shell" :data-layout-instance="instance">
    <p v-if="success" role="status" class="flash" data-testid="flash">
      {{ success }}
    </p>
    <ErrorBoundary :reset-key="page.url">
      <slot />
      <template #fallback>
        <div role="alert" class="error">
          <h1>Something went wrong</h1>
          <p>This page failed to render. Other pages still work.</p>
        </div>
      </template>
    </ErrorBoundary>
  </main>
</template>
