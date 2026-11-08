<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Target']>();
</script>

<template>
  <Head title="Visit target" />
  <h1>Visit target</h1>
  <p data-testid="from">Reached via {{ from }}</p>
  <Link href="/features/tour">Back to features</Link>
</template>
