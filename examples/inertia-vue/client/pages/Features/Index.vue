<script setup lang="ts">
import { Head, Link, WhenVisible, usePoll } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Index']>();

const { stop, polling } = usePoll(400, { only: ['tick'] });
</script>

<template>
  <Head title="Client features" />
  <h1>Client features</h1>
  <nav aria-label="Feature pages" class="stack">
    <Link href="/features/prefetched" prefetch="hover" cache-for="1m">
      Prefetched page
    </Link>
    <Link href="/features/scroll">Infinite scroll</Link>
  </nav>
  <p data-testid="tick">Tick {{ tick }}</p>
  <p data-testid="polling">{{ polling ? 'Polling' : 'Stopped' }}</p>
  <button type="button" @click="stop">Stop polling</button>
  <div class="spacer" aria-hidden="true" />
  <WhenVisible data="below" :buffer="0">
    <template #fallback>
      <p data-testid="below">Not loaded yet</p>
    </template>
    <p data-testid="below">{{ below }}</p>
  </WhenVisible>
</template>
