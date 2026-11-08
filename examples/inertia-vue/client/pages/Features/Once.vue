<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Once']>();
</script>

<template>
  <Head :title="`Once props ${step}`" />
  <h1>Once props: step {{ step }}</h1>
  <p data-testid="plans-token">Plans token {{ plans.token }}</p>
  <p>{{ plans.names.join(', ') }}</p>
  <Link :href="step === 'a' ? '/features/once/b' : '/features/once/a'">
    Go to step {{ step === 'a' ? 'b' : 'a' }}
  </Link>
</template>
