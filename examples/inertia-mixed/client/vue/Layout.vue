<script setup lang="ts">
import { Link } from '@inertiajs/vue3';
import { onMounted } from 'vue';

onMounted(() => {
  document.documentElement.dataset['hydrated'] = 'vue';
});
</script>

<template>
  <nav aria-label="Roots">
    <Link href="/vue">Vue home</Link>
    <Link href="/vue/about">Vue about</Link>
    <Link href="/react">React root</Link>
    <Link href="/svelte">Svelte root</Link>
    <a href="/">HBS index</a>
  </nav>
  <main><slot /></main>
</template>
