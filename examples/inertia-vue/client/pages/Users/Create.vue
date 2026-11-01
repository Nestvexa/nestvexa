<script setup lang="ts">
import { Head, useForm } from '@inertiajs/vue3';

const form = useForm({ name: '', email: '' });

function submit(): void {
  form.post('/users');
}
</script>

<template>
  <Head title="Create user" />
  <h1>Create user</h1>
  <form novalidate @submit.prevent="submit">
    <label for="name">Name</label>
    <input
      id="name"
      v-model="form.name"
      name="name"
      autocomplete="name"
      :aria-invalid="form.errors.name ? 'true' : 'false'"
      :aria-describedby="form.errors.name ? 'name-error' : undefined"
    />
    <p v-if="form.errors.name" id="name-error" class="field-error" role="alert">
      {{ form.errors.name }}
    </p>
    <label for="email">Email</label>
    <input
      id="email"
      v-model="form.email"
      name="email"
      type="email"
      autocomplete="email"
      :aria-invalid="form.errors.email ? 'true' : 'false'"
      :aria-describedby="form.errors.email ? 'email-error' : undefined"
    />
    <p
      v-if="form.errors.email"
      id="email-error"
      class="field-error"
      role="alert"
    >
      {{ form.errors.email }}
    </p>
    <button type="submit" :disabled="form.processing">Save</button>
  </form>
</template>
