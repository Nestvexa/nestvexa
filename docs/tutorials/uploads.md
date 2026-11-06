# Tutorial: add file uploads

You will let users attach files to a Live component, with progress, cancellation,
resumable chunks for a large file, a no-JavaScript form fallback and owner-checked
downloads. The finished code is [`examples/uploads`](../../examples/uploads/README.md)
(`src/attachments.ts`, `src/main.ts`, `views/attachments.hbs`), exercised by
[`tests/browser/uploads.spec.ts`](../../tests/browser/uploads.spec.ts). Reference:
the [uploads guide](../guides/uploads.md), the
[package README](../../packages/uploads/README.md) and
[ADR 0023](../adr/0023-uploads-and-storage.md).

## How an upload flows

1. The browser sends bytes to generated routes under `/_nestvexa/uploads`. The
   server streams them to a private temporary file while enforcing size, type,
   quota, CSRF, `Origin` and identity checks, then returns a short-lived token
   (`nvu_…`).
2. The token lands in a writable Live field. It is a reference, not a file.
3. Your Live action calls `uploads.finalize(request, token, { purpose })`, which
   re-checks identity, purpose, expiry, size, SHA-256, content and (if configured)
   the malware scan, then moves the bytes to storage and returns a
   `FinalizedUpload` that **you** persist.

## 1. Install

```sh
npm install @nestvexa/uploads
```

No cloud SDK is pulled in: S3 requests are signed with SigV4 on `node:crypto`.

## 2. Register the module with purposes

Each purpose names allowed types, a per-file size limit and a file count. Live
purposes are named `<component-name>.<field>`:

<!-- snippet: examples/uploads/src/main.ts -->

```ts
        'attachments.files': {
          types: ['png', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'csv'],
          maxFileSize: 2 * 1024 * 1024,
          maxFiles: 5,
        },
```

`UploadsModule.register({ global: true, origin, directory, resolveIdentity, authorize, purposes })`
also takes `chunkSize`, `tokenTtlMs`, `quotas`, `storage` and `scanner`. Use the
**same** identity resolver as your Live policy so a token can only be finalized by
the session that uploaded it. `directory` must be absolute and outside any served
folder. Call `await configureUploads(app)` before `listen()` (required on Fastify,
harmless on Express) and enable the browser side with
`browser: { uploads: { endpoint: '/_nestvexa/uploads' } }` in `NestvexaModule.forRoot`.

## 3. Accept tokens in a Live component

<!-- snippet: examples/uploads/src/attachments.ts -->

```ts
  /** Server-validated temporary upload references set by `nv:upload="files"`. */
  @State({ writable: true, validate: uploadReferenceField({ max: 5 }) })
  files = '';
```

The `attach` action parses the references, finalizes each with its purpose and
stores the result in the host repository:

<!-- snippet: examples/uploads/src/attachments.ts -->

```ts
// Re-checks identity, purpose, expiry, size, hash, content and scan.
const file = await this.uploads.finalize(this.request, entry.token, {
  purpose: entry.purpose,
});
```

Map `UploadError` codes (`UPLOAD_EXPIRED`, `QUOTA_EXCEEDED`, …) to user messages;
the error body never contains names, paths, tokens or identities.

## 4. Bind the file input

<!-- snippet: examples/uploads/views/attachments.hbs -->

```hbs
    <fieldset>
      <legend>Documents and images</legend>
      <label for="attachment-files">
        Up to 5 files (PNG, JPEG, GIF, WebP, PDF, TXT or CSV), 2 MB each
      </label>
      <input
        id="attachment-files"
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv"
        aria-describedby="attachment-files-status"
        nv:upload="files"
      />
```

`nv:upload="files"` on the `<input type="file">` starts the upload, a
`<progress nv:upload.progress="files">` shows bytes sent, `nv:upload.status`
announces progress in a `role="status"` region and
`nv:upload.cancel` cancels or clears. Every file uses the resumable session
protocol: chunks of `chunkSize` bytes (the example uses 64 KiB to show several),
each retried up to three times after a status query resyncs the received bytes.
Purposes with `direct: true` get a presigned S3 `PUT` instead.

## 5. Keep a no-JavaScript fallback

`UploadsService.receiveForm(request, options, response)` runs the same validation
pipeline for a plain `multipart/form-data` form. The CSRF field must come before
the file fields; answer with a `303` redirect (post/redirect/get). See `/classic`
in the example and the [uploads guide](../guides/uploads.md#3-no-javascript-fallback).

## 6. Serve downloads after your ownership check

<!-- snippet: examples/uploads/src/main.ts -->

```ts
const file = this.repository.find(ownerOf(request), String(id));
if (!file) throw new NotFoundException();
await this.uploads.download(request, response, file, {
  disposition: inline === '1' ? 'inline' : 'attachment',
});
```

`download` streams with backpressure, supports a single `bytes=` range and sends
`nosniff`. Nestvexa does not decide who owns a file: the lookup above is yours.

## 7. Production storage and scanning

- **S3-compatible storage:** `storage: new S3Storage({ endpoint, region, bucket, credentials, prefix })`;
  `presignDownload` issues short-lived URLs. Treat presigned URLs as bearer tokens.
- **Malware scanning:** `scanner: new ClamdScanner({ host, port })` plus
  `requireScan: true` on purposes that need it. Without a scanner `finalize`
  reports `scan: 'not-configured'`; Nestvexa itself detects no malware.
- Persist `FinalizedUpload` rows with owner/tenant columns in your database.

`pnpm test:services` ran the S3 adapter against SeaweedFS and `ClamdScanner`
against ClamAV on 2026-11-02 ([production services](../guides/production-services.md)).

## 8. Test it

```sh
pnpm build
pnpm exec vitest run tests/uploads-validation.test.ts tests/uploads-http.test.ts
pnpm exec playwright test tests/browser/uploads.spec.ts --project=chromium
```

## Limits

> **Known gap:** pending upload tokens live in process memory, so several nodes
> need sticky sessions. There are no Inertia React/Vue/Svelte upload adapters and
> no `@nestvexa/forms` integration for file fields (UP-008). Tenant and
> process-wide quota exhaustion and download backpressure/idle timeouts are
> implemented but have no dedicated tests (UP-005, UP-009). Real AWS S3 has not
> been exercised.
