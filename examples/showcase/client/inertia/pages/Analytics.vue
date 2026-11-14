<script setup lang="ts">
import { Deferred, Head, router } from '@inertiajs/vue3';
import { ref } from 'vue';
import { BarChart } from '../../shared/bar-chart';
import { useTranslate } from '../i18n';
import type { AnalyticsProps } from '../types';

defineProps<AnalyticsProps>();
const t = useTranslate();
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
  <Head :title="t('common:nav.analytics')" />
  <h1>{{ heading }}</h1>
  <ul class="tiles" :aria-label="t('insights:summary')">
    <li class="tile">
      {{ t('insights:open') }}
      <output id="analytics-open">{{ summary.open }}</output>
    </li>
    <li class="tile">
      {{ t('insights:done') }}
      <output id="analytics-done">{{ summary.done }}</output>
    </li>
    <li class="tile">
      {{ t('insights:members') }}
      <output id="analytics-members">{{ summary.members }}</output>
    </li>
  </ul>
  <section aria-labelledby="throughput-heading">
    <h2 id="throughput-heading">{{ t('insights:throughputHeading') }}</h2>
    <Deferred data="throughput">
      <template #fallback>
        <p id="throughput-loading" role="status">
          {{ t('insights:loading') }}
        </p>
      </template>
      <BarChart
        v-if="throughput"
        id-prefix="analytics-chart"
        :caption="t('insights:caption')"
        :labels="throughput.labels"
        :values="throughput.values"
      />
    </Deferred>
  </section>
  <section aria-labelledby="breakdown-heading">
    <h2 id="breakdown-heading">{{ t('insights:breakdownHeading') }}</h2>
    <button
      type="button"
      id="breakdown-load"
      :disabled="loading"
      @click="loadBreakdown"
    >
      {{
        breakdown ? t('insights:refreshBreakdown') : t('insights:loadBreakdown')
      }}
    </button>
    <ul v-if="breakdown" id="breakdown-list">
      <li v-for="row in breakdown" :key="row.name">
        {{ row.name }}: {{ row.open }}
      </li>
    </ul>
  </section>
</template>
