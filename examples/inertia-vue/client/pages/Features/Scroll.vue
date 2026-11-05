<script setup lang="ts">
import { Head, InfiniteScroll } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Scroll']>();
</script>

<template>
  <Head title="Infinite scroll" />
  <h1>Infinite scroll</h1>
  <InfiniteScroll data="items" :buffer="200">
    <ul aria-label="Items" data-testid="items">
      <li v-for="item in items.data" :key="item.id" class="tall-item">
        {{ item.label }}
      </li>
    </ul>
    <template #loading>
      <p role="status">Loading more items…</p>
    </template>
  </InfiniteScroll>
</template>
