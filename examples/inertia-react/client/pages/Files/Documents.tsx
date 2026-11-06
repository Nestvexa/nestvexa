import { Head, useForm } from '@inertiajs/react';
import {
  browserUploadMessage,
  readCookie,
  uploadFile,
} from '@nestvexa/uploads/browser';
import { useEffect, useRef, useState } from 'react';

interface StoredDocument {
  readonly title: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

// The file goes to the @nestvexa/uploads routes first (chunked, with
// progress); the form then submits JSON with the returned nvu_… token. The
// server validates with the same @nestvexa/forms schema for Precognition and
// the submission, finalizes the token and maps failures to useForm errors.
export default function FilesDocuments({
  documents,
}: {
  readonly documents: readonly StoredDocument[];
}) {
  const form = useForm('post', '/documents', { title: '', attachment: '' });
  const [progress, setProgress] = useState<number | undefined>();
  const [status, setStatus] = useState('');
  const upload = useRef<AbortController | undefined>(undefined);
  const { attachment } = form.data;
  // Precognition-validate once per new token (after the state update landed);
  // the latest `validate` is read through a ref so the effect keys on the token.
  const validate = useRef(form.validate);
  validate.current = form.validate;
  useEffect(() => {
    if (attachment) validate.current('attachment');
  }, [attachment]);
  useEffect(() => () => upload.current?.abort(), []);

  async function choose(file: File | undefined): Promise<void> {
    upload.current?.abort();
    form.setData('attachment', '');
    if (!file) return;
    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    setStatus('Uploading 0%');
    try {
      const token = await uploadFile(file, {
        purpose: 'documents',
        csrf: () => readCookie('XSRF-TOKEN'),
        signal: controller.signal,
        onProgress: ({ percentage }) => {
          setProgress(percentage);
          setStatus(`Uploading ${percentage}%`);
        },
      });
      form.setData('attachment', token);
      setStatus(`Uploaded ${file.name}`);
    } catch (error) {
      setProgress(undefined);
      setStatus(`Upload failed: ${browserUploadMessage(error)}`);
    }
  }

  const error = (field: 'title' | 'attachment' | '_form') =>
    (form.errors as Record<string, string | undefined>)[field];
  return (
    <>
      <Head title="Documents" />
      <h1>Documents</h1>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.submit({
            onSuccess: () => {
              form.reset();
              setProgress(undefined);
              setStatus('');
            },
          });
        }}
      >
        {error('_form') ? (
          <p className="field-error" role="alert" data-testid="form-error">
            {error('_form')}
          </p>
        ) : null}
        <label htmlFor="document-title">Title</label>
        <input
          id="document-title"
          name="title"
          value={form.data.title}
          aria-invalid={error('title') ? 'true' : 'false'}
          aria-describedby={error('title') ? 'document-title-error' : undefined}
          onChange={(event) => form.setData('title', event.target.value)}
          onBlur={() => form.validate('title')}
        />
        {error('title') ? (
          <p id="document-title-error" className="field-error" role="alert">
            {error('title')}
          </p>
        ) : null}
        <label htmlFor="document-file">
          File (plain text or PNG, up to 64 KB)
        </label>
        <input
          id="document-file"
          type="file"
          accept=".txt,.png,text/plain,image/png"
          aria-invalid={error('attachment') ? 'true' : 'false'}
          aria-describedby="document-file-status"
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <progress
          aria-label="Upload progress"
          max={100}
          value={progress ?? 0}
          hidden={progress === undefined}
        />
        <p id="document-file-status" role="status">
          {status}
        </p>
        {error('attachment') ? (
          <p
            className="field-error"
            role="alert"
            data-testid="attachment-error"
          >
            {error('attachment')}
          </p>
        ) : null}
        <button type="submit" disabled={form.processing}>
          Save document
        </button>
      </form>
      <ul aria-label="Stored documents">
        {documents.map((document, index) => (
          <li key={`${document.title}-${index}`}>
            {document.title}: {document.name} ({document.size} bytes,{' '}
            {document.type})
          </li>
        ))}
      </ul>
    </>
  );
}
