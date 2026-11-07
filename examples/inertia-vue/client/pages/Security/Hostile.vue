<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { SecurityHostileProps } from '../../../src/page-types';
import { safeHref } from '../../safe-href';

// Every prop is hostile (see src/hostile.ts); each binding must render inert.
const props = defineProps<SecurityHostileProps>();
</script>

<template>
  <Head :title="props.payloads[0] ?? ''" />
  <h1>Hostile page props</h1>
  <!-- An Inertia visit: the props arrive as JSON and the page remounts. -->
  <Link href="/__test/hostile" data-testid="revisit">Load again</Link>
  <ul aria-label="Payloads">
    <li
      v-for="(payload, index) in props.payloads"
      :key="index"
      data-testid="payload"
      :title="payload"
      :data-payload="payload"
    >
      {{ payload }}
    </li>
  </ul>
  <ul aria-label="Links">
    <li v-for="(link, index) in props.links" :key="index">
      <a data-testid="link" :href="safeHref(link)" :data-raw="link">{{
        link
      }}</a>
    </li>
  </ul>
</template>
