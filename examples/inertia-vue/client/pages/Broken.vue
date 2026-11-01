<script setup lang="ts">
import type { BrokenProps } from '../../src/page-types';

// Throws during setup: SSR falls back and the layout's error boundary takes over.
const props = defineProps<BrokenProps>();
throw new Error(props.reason);
</script>

<template>
  <h1>Unreachable</h1>
</template>
