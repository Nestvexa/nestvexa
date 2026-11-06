<script setup lang="ts">
import { Head } from '@inertiajs/vue3';

defineProps<{ title: string }>();
</script>

<template>
  <Head :title="title" />
  <h1>{{ title }}</h1>
  <p>Rendered by Vue through Inertia.</p>
</template>
