<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

// Scroll management by the official client: visits reset the window and every
// `scroll-region` element to the top, `preserveScroll` keeps the position,
// back/forward restores both from the history entry, and a `#hash` scrolls to
// its anchor.
defineProps<FeaturePages['Features/Long']>();
</script>

<template>
  <Head :title="`Long page ${page}`" />
  <h1>Long page {{ page }}</h1>
  <div
    scroll-region
    class="scroll-region"
    data-testid="region"
    role="region"
    aria-label="Scroll region"
  >
    <div class="scroll-region-content">Region content</div>
  </div>
  <div class="long-spacer" aria-hidden="true" />
  <h2 id="anchor">Anchor on page {{ page }}</h2>
  <div class="long-spacer" aria-hidden="true" />
  <nav aria-label="Long pages" class="stack">
    <Link :href="`/features/long/${next}`">Next long page</Link>
    <Link :href="`/features/long/${next}`" preserve-scroll>
      Next, preserving scroll
    </Link>
    <Link :href="`/features/long/${next}#anchor`">Next, to the anchor</Link>
    <Link href="/features/tour">Back to features</Link>
  </nav>
</template>
