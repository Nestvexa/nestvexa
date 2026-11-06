<script setup lang="ts">
import { Head, useForm } from '@inertiajs/vue3';
import {
  browserUploadMessage,
  readCookie,
  uploadFile,
} from '@nestvexa/uploads/browser';
import { computed, onBeforeUnmount, ref } from 'vue';

interface StoredDocument {
  readonly title: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

defineProps<{ documents: readonly StoredDocument[] }>();

// Same flow as the React example: upload through @nestvexa/uploads (progress,
// nvu_… token), then submit JSON with Precognition on the official useForm.
const form = useForm('post', '/documents', { title: '', attachment: '' });
const progress = ref<number | undefined>();
const status = ref('');
let upload: AbortController | undefined;
const errors = computed(
  () => form.errors as Record<string, string | undefined>,
);

async function choose(event: Event): Promise<void> {
  upload?.abort();
  form.attachment = '';
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const controller = new AbortController();
  upload = controller;
  progress.value = 0;
  status.value = 'Uploading 0%';
  try {
    form.attachment = await uploadFile(file, {
      purpose: 'documents',
      csrf: () => readCookie('XSRF-TOKEN'),
      signal: controller.signal,
      onProgress: ({ percentage }) => {
        progress.value = percentage;
        status.value = `Uploading ${percentage}%`;
      },
    });
    status.value = `Uploaded ${file.name}`;
    form.validate('attachment');
  } catch (error) {
    progress.value = undefined;
    status.value = `Upload failed: ${browserUploadMessage(error)}`;
  }
}

function submit(): void {
  form.submit({
    onSuccess: () => {
      form.reset();
      progress.value = undefined;
      status.value = '';
    },
  });
}

onBeforeUnmount(() => upload?.abort());
</script>

<template>
  <Head title="Documents" />
  <h1>Documents</h1>
  <form novalidate @submit.prevent="submit">
    <p
      v-if="errors._form"
      class="field-error"
      role="alert"
      data-testid="form-error"
    >
      {{ errors._form }}
    </p>
    <label for="document-title">Title</label>
    <input
      id="document-title"
      v-model="form.title"
      name="title"
      :aria-invalid="errors.title ? 'true' : 'false'"
      :aria-describedby="errors.title ? 'document-title-error' : undefined"
      @blur="form.validate('title')"
    />
    <p
      v-if="errors.title"
      id="document-title-error"
      class="field-error"
      role="alert"
    >
      {{ errors.title }}
    </p>
    <label for="document-file">File (plain text or PNG, up to 64 KB)</label>
    <input
      id="document-file"
      type="file"
      accept=".txt,.png,text/plain,image/png"
      :aria-invalid="errors.attachment ? 'true' : 'false'"
      aria-describedby="document-file-status"
      @change="choose"
    />
    <progress
      aria-label="Upload progress"
      max="100"
      :value="progress ?? 0"
      :hidden="progress === undefined"
    />
    <p id="document-file-status" role="status">{{ status }}</p>
    <p
      v-if="errors.attachment"
      class="field-error"
      role="alert"
      data-testid="attachment-error"
    >
      {{ errors.attachment }}
    </p>
    <button type="submit" :disabled="form.processing">Save document</button>
  </form>
  <ul aria-label="Stored documents">
    <li
      v-for="(document, index) in documents"
      :key="`${document.title}-${index}`"
    >
      {{ document.title }}: {{ document.name }} ({{ document.size }} bytes,
      {{ document.type }})
    </li>
  </ul>
</template>
