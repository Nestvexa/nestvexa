<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Prefetched']>();
</script>

<template>
  <Head title="Prefetched" />
  <h1>Prefetched page</h1>
  <p data-testid="renders">Server renders: {{ renders }}</p>
  <Link href="/features">Back to features</Link>
</template>
