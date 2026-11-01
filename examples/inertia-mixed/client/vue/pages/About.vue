<script setup lang="ts">
defineProps<{ heading: string; framework: string }>();
</script>

<template>
  <h1>{{ heading }}</h1>
  <p data-testid="framework">
    {{ framework }} page reached without leaving the Vue root.
  </p>
</template>
