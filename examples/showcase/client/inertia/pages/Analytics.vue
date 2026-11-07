<script setup lang="ts">
import { Deferred, Head, router } from '@inertiajs/vue3';
import { ref } from 'vue';
import { BarChart } from '../../shared/bar-chart';
import type { AnalyticsProps } from '../types';

defineProps<AnalyticsProps>();
const loading = ref(false);

/** Partial reload: only the optional `breakdown` prop is requested and merged. */
function loadBreakdown(): void {
  loading.value = true;
  router.reload({
    only: ['breakdown'],
    onFinish: () => {
      loading.value = false;
    },
  });
}
</script>

<template>
  <Head title="Analytics" />
  <h1>{{ heading }}</h1>
  <ul class="tiles" aria-label="Workspace summary">
    <li class="tile">
      Open tasks <output id="analytics-open">{{ summary.open }}</output>
    </li>
    <li class="tile">
      Done tasks <output id="analytics-done">{{ summary.done }}</output>
    </li>
    <li class="tile">
      Members <output id="analytics-members">{{ summary.members }}</output>
    </li>
  </ul>
  <section aria-labelledby="throughput-heading">
    <h2 id="throughput-heading">Weekly throughput</h2>
    <Deferred data="throughput">
      <template #fallback>
        <p id="throughput-loading" role="status">Loading the chart…</p>
      </template>
      <BarChart
        v-if="throughput"
        id-prefix="analytics-chart"
        caption="Completed tasks per week"
        :labels="throughput.labels"
        :values="throughput.values"
      />
    </Deferred>
  </section>
  <section aria-labelledby="breakdown-heading">
    <h2 id="breakdown-heading">Open tasks by member</h2>
    <button
      type="button"
      id="breakdown-load"
      :disabled="loading"
      @click="loadBreakdown"
    >
      {{ breakdown ? 'Refresh breakdown' : 'Load breakdown' }}
    </button>
    <ul v-if="breakdown" id="breakdown-list">
      <li v-for="row in breakdown" :key="row.name">
        {{ row.name }}: {{ row.open }}
      </li>
    </ul>
  </section>
</template>
