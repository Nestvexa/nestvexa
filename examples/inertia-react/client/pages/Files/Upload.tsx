import { Head, useForm } from '@inertiajs/react';
import type { AppPages } from '../../../src/page-types';

// useForm(method, url, data) with validateFiles(): choosing a file sends a
// multipart Precognition request (`Precognition: true`,
// `Precognition-Validate-Only: document`) that the @Precognitive route parses
// with its FileInterceptor and answers with 204 or 422 without storing it.
export default function FilesUpload({ uploads }: AppPages['Files/Upload']) {
  const form = useForm<{ document: File | null }>('post', '/uploads', {
    document: null,
  }).validateFiles();
  return (
    <>
      <Head title="Uploads" />
      <h1>Uploads</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.submit({
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
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            // setData updates the form synchronously, so validate sees the file.
            form.setData('document', file);
            if (file) form.validate('document');
          }}
        />
        {form.errors.document ? (
          <p id="document-error" className="field-error" role="alert">
            {form.errors.document}
          </p>
        ) : null}
        {form.valid('document') ? (
          <p data-testid="document-valid">File accepted</p>
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
