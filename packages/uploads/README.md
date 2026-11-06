# @nestvexa/uploads

Opt-in, storage-agnostic file uploads for NestJS hosts and Nestvexa Live
components: streaming byte limits, extension + declared MIME + magic-byte
validation, short-lived identity-bound temporary tokens, resumable chunked
uploads, local and S3-compatible storage (presigned direct uploads), a malware
scanner hook, a no-JavaScript multipart fallback and safe Range downloads.

Status: experimental `0.1.0-alpha.0`, not published. See [caveats](#production-caveats).

## Install

Not published yet. After `pnpm build && pnpm test:pack`, install the local
tarball. Future registry syntax (subject to owner publication):

```sh
npm install @nestvexa/uploads
pnpm add @nestvexa/uploads
yarn add @nestvexa/uploads
```

Peers: `@nestjs/common` 12, `reflect-metadata` 0.2, `rxjs` 7. Node 22.13+/24.
Runtime dependency: [`busboy`](https://github.com/mscdex/busboy) 1.6 (only for the
no-JavaScript multipart route). **No cloud SDK**: S3 requests are signed with
SigV4 implemented on `node:crypto`. The umbrella `nestvexa` package does **not**
include this package; it only forwards the browser `uploads.endpoint` option to
the Live client.

## Architecture role

```
browser ──POST /sessions──▶ UploadsService ──temp file (private dir)──┐
        ──PUT  chunks ────▶  limits, quotas, CSRF, Origin, identity  │
        ──POST complete ──▶  inspect bytes → token nvu_…  ◀──────────┘
Live action / host route ── uploads.finalize(request, token, {purpose})
        → re-resolve identity, purpose, expiry, size, SHA-256, content, scan
        → storage.put (Local or S3) → FinalizedUpload (persist it yourself)
host route ── uploads.download(request, response, file) → Range, nosniff
```

Temporary files live under `<directory>/tmp/<pid-random>/` (mode 0600 files,
0700 dirs); local permanent objects under `<directory>/objects/<shard>/<random>`.
Names on disk are 256-bit random; the client filename is metadata only.

## Minimal usage

```ts
import { UploadsModule, configureUploads } from '@nestvexa/uploads';

@Module({
  imports: [
    UploadsModule.register({
      global: true, // lets Live components inject UploadsService
      origin: 'https://app.example.com',
      directory: '/var/lib/myapp/uploads', // absolute, outside any webroot
      resolveIdentity: (request) => ({
        binding: `user:${userId(request)}:session:${sessionId(request)}`,
        csrfToken: csrfToken(request),
        tenant: tenantId(request), // optional quota bucket
      }),
      authorize: (identity, purpose, operation) =>
        canUpload(identity, purpose, operation),
      purposes: {
        'attachments.files': {
          types: ['png', 'jpeg', 'pdf'],
          maxFileSize: 5 * 1024 * 1024,
          maxFiles: 5,
        },
      },
    }),
  ],
})
class AppModule {}

const app = await NestFactory.create(AppModule);
await configureUploads(app); // required for Fastify; harmless for Express
```

Live component (purpose = `<component-name>.<field>`):

```ts
@LiveComponent({ name: 'attachments', view: 'attachments' })
class Attachments {
  @State({ writable: true, validate: uploadReferenceField({ max: 5 }) }) files =
    '';
  constructor(
    @Inject(REQUEST) private readonly request: object,
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}
  @Action() async attach() {
    for (const token of parseUploadReferences(this.files, 5))
      await save(
        await this.uploads.finalize(this.request, token, {
          purpose: 'attachments.files',
        }),
      );
    this.files = '';
  }
}
```

```hbs
<input type='file' multiple nv:upload='files' aria-describedby='files-status' />
<progress
  nv:upload.progress='files'
  value='0'
  max='1'
  aria-label='Upload progress'
></progress>
<p id='files-status' role='status' nv:upload.status='files'></p>
<button type='button' nv:upload.cancel='files'>Cancel</button>
<button nv:click='attach'>Attach</button>
```

Enable the client with `NestvexaModule.forRoot(..., { browser: { uploads: { endpoint: '/_nestvexa/uploads' } }, ... })`
or `createLiveClient({ uploads: { endpoint } })`. Full walkthrough:
[uploads guide](../../docs/guides/uploads.md); runnable app:
[examples/uploads](../../examples/uploads/README.md).

## Public API

| Export                                                           | Purpose                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `UploadsModule.register(options)` / `registerAsync`              | Generated routes + `UploadsService`. Async factories cannot change `endpoint`/`global`/`imports`.                               |
| `configureUploads(app)`                                          | Adds pass-through Fastify parsers for `application/octet-stream` and `multipart/form-data`. Call before `listen()`.             |
| `UploadsService.finalize(request, token, { purpose })`           | Single-use commit → `FinalizedUpload`. Does not check CSRF itself: call from an authorized Live action or CSRF-protected route. |
| `UploadsService.peek(request, token, { purpose })`               | Describe a pending upload (name/size/type) for confirmation UIs.                                                                |
| `UploadsService.discard(request, token)`                         | Server-side cancellation.                                                                                                       |
| `UploadsService.receiveForm(request, options, response?)`        | No-JS `multipart/form-data` fallback; CSRF field must precede files. Returns `{ fields, files: UploadReceipt[] }`.              |
| `UploadsService.download(request, response, file, opts)`         | Stream a finalized file after **your** ownership check (`@Res()`).                                                              |
| `UploadsService.presignDownload(file, opts)`                     | Presigned storage URL (S3) or `undefined`.                                                                                      |
| `UploadsService.remove(file)` / `sweep(now?)`                    | Delete a finalized object / run the expiry sweep now.                                                                           |
| `sendDownload`, `parseRange`                                     | Lower-level safe download helper and single-range parser.                                                                       |
| `LocalStorage`, `S3Storage`, `UploadStorage`                     | Storage adapters and the interface for your own.                                                                                |
| `signRequest`, `presignUrl`, `canonicalRequest`, …               | SigV4 primitives (S3 path rules).                                                                                               |
| `UploadScanner`, `ScanVerdict`, `ClamdScanner`                   | Malware scanning hook and a clamd INSTREAM adapter.                                                                             |
| `FILE_TYPES`, `defineFileType`, `DANGEROUS_EXTENSIONS`           | Built-in types (`png`, `jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`) and validated custom types.                                  |
| `parseClientFilename`, `contentDisposition`                      | Filename policy and RFC 6266/5987 header builder.                                                                               |
| `inspectContent`, `TextValidator`, `dangerousContent`            | Content checks.                                                                                                                 |
| `uploadReferenceField`, `parseUploadReferences`, `isUploadToken` | Live field validator and parser for `''`/`nvu_…`/comma lists.                                                                   |
| `UploadError` (`code: UploadErrorCode`)                          | `HttpException` with body `{ statusCode, code }` — never names, paths, tokens or identities.                                    |

### Generated routes (prefix default `/_nestvexa/uploads`)

| Route                                   | Notes                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /files`                           | Raw `application/octet-stream`; headers `x-nestvexa-upload-purpose`, `-name` (percent-encoded), `-type`. |
| `POST /sessions`                        | JSON `{purpose, name, type?, size}` → `{session, mode: 'chunked' \| 'direct', chunkSize, …}`.            |
| `GET /sessions/:id`                     | Resume query: `received`, `nextIndex`.                                                                   |
| `PUT /sessions/:id/chunks/:index`       | Exactly the next chunk; `x-nestvexa-chunk-offset`, optional `x-nestvexa-chunk-sha256`.                   |
| `POST /sessions/:id/complete`           | JSON `{digest?}` (SHA-256 of concatenated chunk digests) → `{token, …}`.                                 |
| `DELETE /sessions/:id`, `/files/:token` | Cancellation.                                                                                            |

All need the host identity and `x-nestvexa-csrf`; non-GET routes need the exact
`Origin`. Content codings (gzip, …) are refused. Responses are `no-store` + `nosniff`.

## Defaults

| Option                                          | Default                                                                                             | Bounds          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------- |
| `endpoint`                                      | `/_nestvexa/uploads`                                                                                |                 |
| `tokenTtlMs`                                    | 15 min                                                                                              | 10 s – 24 h     |
| `chunkSize`                                     | 1 MiB                                                                                               | 16 KiB – 16 MiB |
| `idleTimeoutMs` / `maxRequestMs`                | 30 s / 10 min                                                                                       |                 |
| `sweepIntervalMs`                               | 60 s                                                                                                |                 |
| `scanTimeoutMs`                                 | 60 s                                                                                                |                 |
| purpose `maxFiles`                              | 10 pending per identity/purpose                                                                     | 1 – 100         |
| purpose `allowEmpty` / `requireScan` / `direct` | `false`                                                                                             |                 |
| quotas identity files / bytes                   | 20 / 256 MiB                                                                                        |                 |
| quotas tenant files / bytes                     | 200 / 2 GiB                                                                                         |                 |
| quotas process files / bytes                    | 2000 / 8 GiB                                                                                        |                 |
| concurrent bodies per identity                  | 4                                                                                                   |                 |
| requests per identity/minute                    | 240                                                                                                 |                 |
| `storage`                                       | `LocalStorage(<directory>/objects)`                                                                 |                 |
| `scanner`                                       | none (`scan: 'not-configured'`)                                                                     |                 |
| `instrumentation`                               | none (`nestvexa.upload.receive` / `.finalize` spans: mode, purpose, bytes, file count; never names) |                 |

## Security model

- **Identity**: the host `resolveIdentity` (same contract as Live) is the only
  source of identity; tokens store a SHA-256 of the binding and the tenant.
  Another identity presenting a token gets `404 UPLOAD_NOT_FOUND` (no oracle).
- **Authorization**: `authorize(identity, purpose, 'upload' | 'finalize' | 'discard')`
  runs on every operation. Downloads are authorized by **your** route.
- **CSRF/Origin**: custom CSRF header + exact Origin on the JSON/raw routes; the
  form route requires the CSRF field before any file part and rejects a foreign Origin.
- **Bytes**: limits are enforced while streaming (declared `Content-Length` over
  the limit is refused before reading); chunk sizes/offsets are exact; the
  assembled file is re-read for size, SHA-256, magic bytes or strict UTF-8 text,
  and executable/HTML/SVG/XML signatures are denied even if renamed. Nothing is
  decompressed (zip-bomb exposure is limited to declared/actual stored bytes).
- **Names**: traversal, separators, control/bidi characters, hidden names and
  dangerous inner extensions (`x.php.png`) are refused; storage names are random.
- **Finalize**: single use, re-resolves identity, checks purpose/expiry, re-reads
  the file (tamper detection), runs the scanner, then commits.
- **Downloads**: RFC 5987 `Content-Disposition` (attachment unless a raster image
  asks for inline), `nosniff`, `CSP: sandbox`, `CORP: same-origin`, private
  no-store caching, single Range, idle timeout. No URL is ever fetched (no SSRF);
  S3 endpoints are static configuration and keys are server-generated.
- **Malware**: no engine is bundled. Configure `scanner` (e.g. `ClamdScanner`
  against a clamd you operate) and set `requireScan` where policy demands it.

## Deploy notes

- Point `directory` at a private volume (not under `public/`), with enough space
  for `quotas.totalBytes`. On S3, keep the bucket private and enable CORS for
  `PUT` from your origin only if you use `direct: true`; add a lifecycle rule to
  remove abandoned unfinalized direct objects as a backstop.
- State (pending tokens/sessions) is **in process memory**: use sticky sessions or
  a single upload node; pending uploads are lost on restart (their files are removed).
- Reverse proxies: allow request bodies of `chunkSize` (+ headers) on `PUT
…/chunks/*`, and of `maxFileSize` on `POST /files` and your form route.
- Call `app.enableShutdownHooks()` so temporary files are removed on SIGTERM.

## Testing

```sh
pnpm build
pnpm exec vitest run tests/uploads-validation.test.ts tests/uploads-http.test.ts tests/uploads-limits.test.ts tests/uploads-s3.test.ts tests/client-upload.test.ts
pnpm exec playwright test tests/browser/uploads.spec.ts
```

The S3 suite verifies SigV4 against AWS published vectors and runs against an
in-process S3-compatible **test double** (`tests/support/fake-s3.ts`).
`pnpm test:services` runs `S3Storage` against a real S3-compatible server (signed
PUT/HEAD/GET/Range/DELETE, presigned URLs, forged-signature rejection) and
`ClamdScanner` against a real clamd (clean file and EICAR); the 2026-11-02 run used
SeaweedFS and ClamAV in Docker and is recorded in
[`services-evidence-2026-11-02.json`](../../docs/implementation/services-evidence-2026-11-02.json). See the
[production services guide](../../docs/guides/production-services.md). Real AWS S3
has not been exercised.

`tests/uploads-limits.test.ts` exhausts tenant file/byte and process-wide
file/byte quotas over real HTTP (and shows quota release on cancel and on
finalize), drives `sendDownload` with a non-reading client, a client stalled
past the idle timeout and a hanging source, and finalizes uploads through
`@nestvexa/forms` file fields.

## Forms

`@nestvexa/forms` `defineForm({ files })` holds upload references in form
state and `finalizeFileField` maps `UploadError` codes to field errors; see the
[uploads guide](../../docs/guides/uploads.md#forms-integration).

## Production caveats

- In-memory token/session store; no cross-process coordination yet.
- Resumable uploads resume within the page lifetime; the client does not persist
  sessions across reloads (the `GET` status API supports it).
- Polyglot files (valid image headers carrying other data) cannot be ruled out by
  signature checks; downloads are therefore served as sandboxed attachments.
- Direct (S3) uploads are re-read in full on completion and finalization.
- Inertia/React/Vue/Svelte upload adapters are not implemented yet; the Inertia
  examples upload multipart with the official `useForm` progress and Nest's
  own file interceptor, not this package.

## Compatibility

Express and Fastify (Nest 12) are tested over real HTTP. Browser client tested in
Chromium, Firefox and WebKit. Changelog: [CHANGELOG](../../CHANGELOG.md); design:
[ADR 0023](../../docs/adr/0023-uploads-and-storage.md).
