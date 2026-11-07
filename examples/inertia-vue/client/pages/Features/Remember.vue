<script setup lang="ts">
import { Head, Link, useForm, useRemember } from '@inertiajs/vue3';
import { reactive } from 'vue';

// Both are stored in the history entry by the official client and restored
// when the user navigates back to this page. A reactive object goes in, so
// the same reactive object comes back (not a ref).
const note = useRemember(
  reactive({ draft: '' }),
  'Features/Remember:draft',
) as {
  draft: string;
};
const form = useForm('Features/Remember:form', { topic: '' });
</script>

<template>
  <Head title="Remembered state" />
  <h1>Remembered state</h1>
  <label for="draft">Draft note</label>
  <input id="draft" v-model="note.draft" />
  <label for="topic">Form topic</label>
  <input id="topic" v-model="form.topic" />
  <p>
    <Link href="/features/tour">Back to features</Link>
  </p>
</template>
