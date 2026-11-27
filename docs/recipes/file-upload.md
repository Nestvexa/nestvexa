# Upload files from a Live component

**Goal:** let a user pick files with progress and cancel, upload them in chunks
to private storage, attach them in a Live action, and download them again only
as their owner. The same pipeline serves a no-JavaScript form.

Example: [examples/uploads](../../examples/uploads/README.md) (port 3105). For S3
storage see [examples/upload-to-s3](../../examples/upload-to-s3/README.md).

## 1. Declare purposes

Every upload names a purpose with an allowlist of detected file types, a size
limit and a file count. `authorize` decides which identities may use a purpose:

<!-- snippet: examples/uploads/src/main.ts -->

```ts
        'attachments.files': {
          types: ['png', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'csv'],
          maxFileSize: 2 * 1024 * 1024,
          maxFiles: 5,
        },
```

`UploadsModule.register` also takes the `origin`, a private `directory` outside
any served folder, the host `resolveIdentity`, `chunkSize` and `tokenTtlMs`. Call
`await configureUploads(app)` next to `configureNestvexa(app)`.

## 2. Bind the file input to Live state

`nv:upload="files"` uploads the chosen files to the uploads endpoint and writes
the temporary references into the writable `files` state field;
`nv:upload.progress`, `nv:upload.status` and `nv:upload.cancel` drive the
progress bar, the announcement and cancellation. The component validates the
references and finalizes each one in an action:

<!-- snippet: examples/uploads/src/attachments.ts -->

```ts
for (const entry of pending) {
  // Re-checks identity, purpose, expiry, size, hash, content and scan.
  const file = await this.uploads.finalize(this.request, entry.token, {
    purpose: entry.purpose,
  });
  this.repository.add(owner, file);
  attached++;
}
```

The state field is declared with
`@State({ writable: true, validate: uploadReferenceField({ max: 5 }) })`, so the
browser can only write well-formed upload references into it.

## 3. Download through an authorization check

<!-- snippet: examples/uploads/src/main.ts -->

```ts
const file = this.repository.find(ownerOf(request), String(id));
if (!file) throw new NotFoundException();
await this.uploads.download(request, response, file, {
  disposition: inline === '1' ? 'inline' : 'attachment',
});
```

## Security notes

- Upload tokens are bound to the identity that created them; another session
  cannot finalize them. The extension, the declared MIME type and the magic bytes
  must agree, and executable, HTML, SVG and XML content is refused even if renamed.
- Storage is private: files are served only through your controller, which looks
  them up by owner first.
- Pending upload tokens are process-local. With several replicas, use sticky
  sessions for uploads ([multiple replicas](../deployment/multi-replica-redis.md#sticky-sessions-required-for-uploads-and-for-live-without-a-shared-store)).
- Add a malware scanner (ClamAV) for untrusted files; see the guide.

## Tests

- [tests/browser/uploads.spec.ts](../../tests/browser/uploads.spec.ts): several
  files with progress, cancelling a chunked upload, server rejections, ranged
  downloads and the no-JavaScript form in three browsers.
- [tests/uploads-http.test.ts](../../tests/uploads-http.test.ts) and
  [tests/uploads-validation.test.ts](../../tests/uploads-validation.test.ts):
  limits, tokens, content detection and stalled uploads.
- [tests/browser/upload-to-s3.spec.ts](../../tests/browser/upload-to-s3.spec.ts):
  the S3 example.

See also: [uploads guide](../guides/uploads.md) and the
[uploads tutorial](../tutorials/uploads.md).
