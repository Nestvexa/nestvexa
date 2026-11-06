<script lang="ts">
  import { useForm } from '@inertiajs/svelte';
  import {
    browserUploadMessage,
    readCookie,
    uploadFile,
  } from '@nestvexa/uploads/browser';
  import { onDestroy } from 'svelte';

  interface StoredDocument {
    readonly title: string;
    readonly name: string;
    readonly size: number;
    readonly type: string;
  }

  let { documents }: { documents: readonly StoredDocument[] } = $props();

  // Same flow as the React example: upload through @nestvexa/uploads
  // (progress, nvu_… token), then submit JSON with Precognition on the
  // official useForm.
  const form = useForm('post', '/documents', { title: '', attachment: '' });
  let progress = $state<number | undefined>();
  let status = $state('');
  let upload: AbortController | undefined;
  const errors = $derived(form.errors as Record<string, string | undefined>);

  async function choose(event: Event): Promise<void> {
    upload?.abort();
    form.attachment = '';
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const controller = new AbortController();
    upload = controller;
    progress = 0;
    status = 'Uploading 0%';
    try {
      form.attachment = await uploadFile(file, {
        purpose: 'documents',
        csrf: () => readCookie('XSRF-TOKEN'),
        signal: controller.signal,
        onProgress: ({ percentage }) => {
          progress = percentage;
          status = `Uploading ${percentage}%`;
        },
      });
      status = `Uploaded ${file.name}`;
      form.validate('attachment');
    } catch (error) {
      progress = undefined;
      status = `Upload failed: ${browserUploadMessage(error)}`;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    form.submit({
      onSuccess: () => {
        form.reset();
        progress = undefined;
        status = '';
      },
    });
  }

  onDestroy(() => upload?.abort());
</script>

<svelte:head>
  <title>Documents · Nestvexa Svelte</title>
</svelte:head>

<h1>Documents</h1>
<form novalidate onsubmit={submit}>
  {#if errors._form}
    <p class="field-error" role="alert" data-testid="form-error">
      {errors._form}
    </p>
  {/if}
  <label for="document-title">Title</label>
  <input
    id="document-title"
    name="title"
    bind:value={form.title}
    aria-invalid={errors.title ? 'true' : 'false'}
    aria-describedby={errors.title ? 'document-title-error' : undefined}
    onblur={() => form.validate('title')}
  />
  {#if errors.title}
    <p id="document-title-error" class="field-error" role="alert">
      {errors.title}
    </p>
  {/if}
  <label for="document-file">File (plain text or PNG, up to 64 KB)</label>
  <input
    id="document-file"
    type="file"
    accept=".txt,.png,text/plain,image/png"
    aria-invalid={errors.attachment ? 'true' : 'false'}
    aria-describedby="document-file-status"
    onchange={choose}
  />
  <progress
    aria-label="Upload progress"
    max="100"
    value={progress ?? 0}
    hidden={progress === undefined}
  ></progress>
  <p id="document-file-status" role="status">{status}</p>
  {#if errors.attachment}
    <p class="field-error" role="alert" data-testid="attachment-error">
      {errors.attachment}
    </p>
  {/if}
  <button type="submit" disabled={form.processing}>Save document</button>
</form>
<ul aria-label="Stored documents">
  {#each documents as document, index (`${document.title}-${index}`)}
    <li>
      {document.title}: {document.name} ({document.size} bytes, {document.type})
    </li>
  {/each}
</ul>
