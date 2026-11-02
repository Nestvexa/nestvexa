<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import type { UsersIndexProps } from '../../../src/page-types';

defineProps<UsersIndexProps>();
</script>

<template>
  <Head title="Users" />
  <h1>Users</h1>
  <ul aria-label="Users">
    <li v-for="user in users" :key="user.id">
      <Link :href="`/users/${user.id}`">{{ user.name }}</Link>
    </li>
  </ul>
</template>
