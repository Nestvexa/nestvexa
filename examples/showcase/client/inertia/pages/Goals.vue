<script setup lang="ts">
import { Head, useForm } from '@inertiajs/vue3';
import type { GoalsProps } from '../types';

defineProps<GoalsProps>();
const form = useForm({ title: '', target: '100' });

function submit(): void {
  form.post('/insights/goals', {
    preserveScroll: true,
    onSuccess: () => form.reset(),
  });
}
</script>

<template>
  <Head title="Goals" />
  <h1>Goals</h1>
  <ul id="goal-list" aria-label="Goals">
    <li v-for="goal in goals" :key="goal.id">
      {{ goal.title }}: <span>{{ goal.progress }}% of {{ goal.target }}%</span>
    </li>
    <li v-if="goals.length === 0" id="goal-empty">No goals yet.</li>
  </ul>
  <section v-if="canCreate" aria-labelledby="goal-form-heading">
    <h2 id="goal-form-heading">Add a goal</h2>
    <form id="goal-form" novalidate @submit.prevent="submit">
      <label for="goal-title">Title</label>
      <input
        id="goal-title"
        v-model="form.title"
        name="title"
        maxlength="200"
        :aria-invalid="form.errors.title ? 'true' : 'false'"
        :aria-describedby="form.errors.title ? 'goal-title-error' : undefined"
      />
      <p
        v-if="form.errors.title"
        id="goal-title-error"
        class="error"
        role="alert"
      >
        {{ form.errors.title }}
      </p>
      <label for="goal-target">Target (%)</label>
      <input
        id="goal-target"
        v-model="form.target"
        name="target"
        inputmode="numeric"
        maxlength="3"
        :aria-invalid="form.errors.target ? 'true' : 'false'"
        :aria-describedby="form.errors.target ? 'goal-target-error' : undefined"
      />
      <p
        v-if="form.errors.target"
        id="goal-target-error"
        class="error"
        role="alert"
      >
        {{ form.errors.target }}
      </p>
      <button type="submit" :disabled="form.processing">Add goal</button>
    </form>
  </section>
  <p v-else id="goal-readonly">Only workspace admins can add goals.</p>
</template>
