<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import type { FeaturePages } from '../../../src/page-types';

defineProps<FeaturePages['Features/Tour']>();
</script>

<template>
  <Head :title="title" />
  <h1>{{ title }}</h1>
  <nav aria-label="Tour pages" class="stack">
    <Link href="/features/slow" component="Features/Slow">Instant visit</Link>
    <Link href="/features/target?from=transition" view-transition>
      View transition
    </Link>
    <Link href="/features/remember">Remembered state</Link>
    <Link href="/features/once/a">Once props</Link>
    <Link href="/features/todos">Optimistic todos</Link>
    <Link href="/features/long/1">Long pages</Link>
    <Link href="/features/slow">Slow page</Link>
    <Link href="/features/actions">Typed actions</Link>
  </nav>
  <h2>Manual visits</h2>
  <div class="stack">
    <button
      type="button"
      @click="
        router.visit('/features/target', { data: { from: 'router.visit' } })
      "
    >
      Visit with router.visit
    </button>
    <button
      type="button"
      @click="router.post('/features/ping', { source: 'router.post' })"
    >
      Post with router.post
    </button>
    <Link
      href="/features/ping"
      method="post"
      as="button"
      :data="{ source: 'link.post' }"
    >
      Post with a link
    </Link>
    <button
      type="button"
      @click="router.visit('/features/slow', { showProgress: false })"
    >
      Quiet slow visit
    </button>
  </div>
</template>
