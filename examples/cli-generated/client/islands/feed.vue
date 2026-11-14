<script setup lang="ts">
import { ref } from 'vue';
import type { IslandContext } from '@nestvexa/islands/client';

const props = withDefaults(
  defineProps<{ label?: string; island: IslandContext }>(),
  {
    label: 'Feed',
  },
);
const count = ref(0);
function increment(): void {
  count.value++;
  props.island.emit('feed.clicked', { count: count.value });
}
</script>

<template>
  <button type="button" @click="increment">
    {{ props.label }}: {{ count }}
  </button>
</template>
