<script setup lang="ts">
import { Deferred, Head, Link, router } from '@inertiajs/vue3';
import type { HomeProps } from '../../src/page-types';

defineProps<HomeProps>();

function loadExtra(): void {
  router.reload({ only: ['extra'] });
}
</script>

<template>
  <Head title="Home" />
  <h1>{{ greeting }}</h1>
  <p data-testid="visits">Visits this session: {{ visits }}</p>
  <p>
    Props come from the {{ renderedBy }}; this markup was rendered on the
    server.
  </p>
  <Deferred data="stats">
    <template #fallback>
      <p data-testid="stats">Loading stats…</p>
    </template>
    <p data-testid="stats">Users: {{ stats?.users }}</p>
  </Deferred>
  <button type="button" @click="loadExtra">Load extra</button>
  <p v-if="extra !== undefined" data-testid="extra">{{ extra }}</p>
  <p><Link href="/users/create">Create a user</Link></p>
</template>
