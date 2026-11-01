<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import type { UsersShowProps } from '../../../src/page-types';

defineProps<UsersShowProps>();
</script>

<template>
  <Head :title="user.name" />
  <h1>{{ user.name }}</h1>
  <dl>
    <dt>Email</dt>
    <dd data-testid="email">{{ user.email }}</dd>
  </dl>
</template>
