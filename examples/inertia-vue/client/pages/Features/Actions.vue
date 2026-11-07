<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import type { FeaturePages } from '../../../src/page-types';
import { actionComposables } from '../../actions';

// A typed server action called from an Inertia page through the generated
// Vue composable: input, output and error field types come from the server's
// NotesActions.add signature. The board the page was rendered with is the
// initial data, the optimistic value shows while the call is pending and is
// rolled back when the server rejects it.
const props = defineProps<FeaturePages['Features/Actions']>();
const text = ref('');
const add = actionComposables.useNotesAdd({
  initialData: props.board,
  optimistic: (current, input) => ({
    total: (current?.total ?? 0) + 1,
    latest: [input.text, ...(current?.latest ?? [])].slice(0, 5),
  }),
  onSuccess: () => {
    text.value = '';
  },
});
const issue = computed(() =>
  add.state.value.error?.issues.find((entry) => entry.path[0] === 'text'),
);
const shown = computed(() => add.state.value.data ?? props.board);

function submit(): void {
  void add.run({ text: text.value });
}
</script>

<template>
  <Head title="Typed actions" />
  <h1>Typed server actions</h1>
  <p
    data-testid="notes-status"
    :data-optimistic="String(add.state.value.optimistic)"
  >
    {{ add.state.value.status }}: {{ shown.total }} notes
  </p>
  <ul aria-label="Notes" data-testid="notes">
    <li v-for="(note, index) in shown.latest" :key="`${index}-${note}`">
      {{ note }}
    </li>
  </ul>
  <form novalidate @submit.prevent="submit">
    <label for="note">Note</label>
    <input
      id="note"
      v-model="text"
      :aria-invalid="issue ? 'true' : 'false'"
      :aria-describedby="issue ? 'note-error' : undefined"
    />
    <p v-if="issue" id="note-error" class="field-error" role="alert">
      {{ issue.message }}
    </p>
    <button type="submit" :disabled="add.state.value.pending">Add note</button>
  </form>
  <p>
    <Link href="/features/tour">Back to features</Link>
  </p>
</template>
