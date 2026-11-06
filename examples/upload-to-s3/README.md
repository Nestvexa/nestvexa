# Upload to S3-compatible storage

A Nest (Express) app that stores documents in an S3-compatible bucket with
`@nestvexa/uploads`:

- **Direct-to-bucket uploads** (`/`). The Live component's `nv:upload="files"`
  input starts an upload session for the purpose `documents.files`
  (`direct: true`). The server answers with a presigned `PUT` URL that signs the
  exact `content-type` and `content-length`; the browser sends the bytes
  straight to the bucket. No storage credential ever reaches the browser.
- **Finalize revalidation.** "Store uploaded files" calls
  `UploadsService.finalize()`, which re-reads the stored object: owner, purpose,
  expiry, exact size, magic bytes and SHA-256. A PDF declared as a PNG is
  refused (`CONTENT_MISMATCH`) and the object is deleted from the bucket.
- **Owner-only downloads.** `/files/:id/download` streams the object through the
  server (Range aware, `nosniff`, attachment disposition); `/files/:id/link`
  redirects to a 60-second presigned `GET` with a forced attachment
  disposition. Both look the file up in the current session's own records, so
  another session gets `404`.
- **Delete** is a plain `POST /files/:id/delete` form (exact `Origin` and the
  session CSRF token) followed by a `303` redirect. It works with and without
  JavaScript and deletes the bucket object.
- **No-JavaScript fallback** (`/classic`). A multipart form posts through the
  server (`receiveForm`, same limits and content checks); finalize then writes
  the object to the same bucket.

## Run

Build once from the repository root (`pnpm install`, `pnpm build`), then
provide the storage settings. They are read only from the environment:

| Variable               | Example                  | Required |
| ---------------------- | ------------------------ | -------- |
| `S3_ENDPOINT`          | `http://127.0.0.1:9000`  | yes      |
| `S3_REGION`            | `us-east-1`              | yes      |
| `S3_BUCKET`            | `nestvexa-example`       | yes      |
| `S3_ACCESS_KEY_ID`     | (your key id)            | yes      |
| `S3_SECRET_ACCESS_KEY` | (your secret)            | yes      |
| `S3_PREFIX`            | `uploads/`               | no       |
| `PORT`                 | `3117` (default)         | no       |
| `UPLOADS_DIR`          | private temporary folder | no       |

The process exits before listening and names every missing variable (never a
value). `S3_ENDPOINT` must be an origin without credentials or a path; the
bucket is addressed path-style (`endpoint/bucket/key`), which MinIO and most
S3-compatible servers accept.

```sh
S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 S3_BUCKET=nestvexa-example \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
pnpm --filter @nestvexa/example-upload-to-s3 start   # http://127.0.0.1:3117
```

The bucket must allow CORS `PUT` (header `content-type`) from the app origin
for direct uploads.

### Without a real bucket

The repository ships an in-memory S3-compatible **test double** used by the
tests. It verifies SigV4 signatures, presigned expiry and signed headers, but it
is not a substitute for running against AWS S3 or MinIO:

```sh
FAKE_S3_PORT=3118 FAKE_S3_CORS_ORIGIN=http://127.0.0.1:3117 \
  pnpm exec tsx tests/support/fake-s3-server.ts
# then start the example with S3_ENDPOINT=http://127.0.0.1:3118 S3_REGION=us-test-1
# S3_BUCKET=nestvexa-example S3_ACCESS_KEY_ID=NESTVEXAEXAMPLEKEY
# S3_SECRET_ACCESS_KEY=nestvexa-example-secret-0123456789
```

Those credentials are public test values. The double's `GET /__fake/objects`
listing is unauthenticated and exists only in the double.

## Tests

[`tests/browser/upload-to-s3.spec.ts`](../../tests/browser/upload-to-s3.spec.ts)
runs in Chromium, Firefox and WebKit against the example (root suite port
**3117**) and the test double (port **3118**): direct upload with no server
chunk requests, the object present in the bucket with a generated key, streamed
and presigned downloads byte-for-byte, delete removing the object, another
session refused (`404` for download/link, `403` for a forged delete even with
the owner's CSRF token), cross-origin delete refused, oversized, dangerous and
mislabelled files refused, the no-JavaScript form, and axe scans of both pages.

## Security notes

- Keep the bucket private. Credentials stay on the server; the browser only
  receives presigned URLs that expire with the upload token (10 minutes here)
  or after 60 seconds for downloads.
- The CSP allows `connect-src` to this origin and the bucket origin only.
- Object keys are generated; user file names are metadata used only for the
  sanitized `Content-Disposition`.
- Direct objects are verified on completion and finalize; an unfinished direct
  object can remain in the bucket if the user abandons the flow. Add a bucket
  lifecycle rule that deletes unfinalized objects as a backstop.
- Ownership is a guest session in process memory. A real host binds identity to
  its authentication, stores file rows (key, owner, tenant, digest) in its
  database, uses a persistent session store and HTTPS-only cookies, and adds a
  malware scanner (`scanner` option, `requireScan`) where needed.

## Known gaps

- Tested against the in-repository S3 test double only; running the same flow
  against AWS S3 or MinIO is an owner/CI step.
- No virus scanning is configured in this example.
- Metadata and sessions are in memory and do not survive a restart.
