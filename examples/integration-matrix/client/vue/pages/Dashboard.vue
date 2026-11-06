<script setup lang="ts">
import { Deferred, Head, router } from '@inertiajs/vue3';
import type { DashboardProps } from '../../../src/page-types';

defineProps<DashboardProps>();

function loadExtra(): void {
  router.reload({ only: ['extra'] });
}
</script>

<template>
  <Head title="Dashboard" />
  <h1>{{ heading }}</h1>
  <p data-testid="framework">Rendered by {{ framework }}</p>
  <Deferred data="stats">
    <template #fallback>
      <p data-testid="stats">Loading stats…</p>
    </template>
    <p data-testid="stats">Users: {{ stats?.users }}</p>
  </Deferred>
  <button type="button" @click="loadExtra">Load extra</button>
  <p v-if="extra !== undefined" data-testid="extra">{{ extra }}</p>
</template>
