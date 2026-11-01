import { Head, useForm } from '@inertiajs/react';
import type { AppPages } from '../../../src/page-types';

export default function FilesUpload({ uploads }: AppPages['Files/Upload']) {
  const form = useForm<{ document: File | null }>({ document: null });
  return (
    <>
      <Head title="Uploads" />
      <h1>Uploads</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.post('/uploads', {
            forceFormData: true,
            onSuccess: () => form.reset(),
          });
        }}
      >
        <label htmlFor="document">
          Document (plain text or PNG, up to 64 KB)
        </label>
        <input
          id="document"
          name="document"
          type="file"
          accept="text/plain,image/png"
          aria-invalid={form.errors.document ? 'true' : 'false'}
          aria-describedby={form.errors.document ? 'document-error' : undefined}
          onChange={(event) =>
            form.setData('document', event.target.files?.[0] ?? null)
          }
        />
        {form.errors.document ? (
          <p id="document-error" className="field-error" role="alert">
            {form.errors.document}
          </p>
        ) : null}
        {form.progress ? (
          <progress value={form.progress.percentage ?? 0} max={100}>
            {form.progress.percentage}%
          </progress>
        ) : null}
        <button type="submit" disabled={form.processing}>
          Upload
        </button>
      </form>
      <ul aria-label="Uploaded files">
        {uploads.map((upload, index) => (
          <li key={`${upload.name}-${index}`}>
            {upload.name} ({upload.size} bytes, {upload.type})
          </li>
        ))}
      </ul>
    </>
  );
}
