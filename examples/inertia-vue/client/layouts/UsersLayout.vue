<script setup lang="ts">
import { Link } from '@inertiajs/vue3';
</script>

<template>
  <section class="section" aria-label="Users section">
    <nav aria-label="Users">
      <Link href="/users">All users</Link>
      <Link href="/users/create">New user</Link>
    </nav>
    <slot />
  </section>
</template>
