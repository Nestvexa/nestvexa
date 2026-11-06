<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import type { UsersProps } from '../../../src/page-types';

defineProps<UsersProps>();
</script>

<template>
  <Head title="Users" />
  <h1>Users</h1>
  <ul aria-label="Users" data-testid="users">
    <li v-for="user in users" :key="user.id">
      {{ user.name }} ({{ user.email }})
    </li>
  </ul>
</template>
