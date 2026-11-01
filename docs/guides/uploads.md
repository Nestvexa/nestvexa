# Uploads, downloads and file storage

`@nestvexa/uploads` is an opt-in Nest module. This guide walks through the
lifecycle, Live integration, the no-JavaScript fallback, storage choices and the
threat model. API tables and defaults are in the
[package README](../../packages/uploads/README.md).

## 1. Lifecycle

1. **Temporary upload.** The browser sends bytes to the generated routes. The
   server enforces the identity, CSRF header, Origin, purpose policy, quotas and
   byte limits while streaming, writes to a private temporary file and re-reads it
   to compute the SHA-256 and check magic bytes or strict UTF-8 text rules.
2. **Temporary token.** The response carries `nvu_` + 256 random bits. The server
   stores only `sha256(token)` mapped to the identity binding hash, tenant,
   purpose, size, hash and expiry (default 15 minutes).
3. **Finalize.** Your Live action or controller calls
   `uploads.finalize(request, token, { purpose })`. Identity is resolved again, the
   purpose must match, the token must be unexpired and unused, and the file is
   re-read: a size or hash change is `409 UPLOAD_TAMPERED`. The scanner runs if
   configured, then storage commits and the token is spent (a second call returns
   `409 UPLOAD_ALREADY_FINALIZED`).
4. **Persist and download.** Save the returned `FinalizedUpload` (key, name,
   content type, size, sha256) with your own ownership columns. Serve it from a
   route that checks ownership, then `uploads.download(request, response, file)`.

Expired or abandoned temporary files are removed by a sweep timer, on
cancellation (`DELETE` routes or `uploads.discard`), when a client disconnects
mid-body, on application shutdown, and — for crashed processes — on the next
start once the directory is older than twice the token lifetime.

## 2. Live components

The client grammar adds one closed, data-only directive family. Values are field
names; the purpose is derived as `<component-name>.<field>`, so markup cannot
choose a URL, purpose or policy.

| Directive                    | Element                                              | Behavior                                                                                                                   |
| ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `nv:upload="files"`          | `<input type="file">` (one per field, no `nv:model`) | On change, uploads every selected file, then sets the `files` state field to the comma-joined tokens.                      |
| `nv:upload.progress="files"` | `<progress>`                                         | `max` = total bytes, `value` = bytes sent (XMLHttpRequest progress).                                                       |
| `nv:upload.status="files"`   | text-only element                                    | "Uploading 40%", "Uploaded 2 files", "Upload cancelled", "Upload failed: …". Add `role="status"`.                          |
| `nv:upload.cancel="files"`   | `<button type="button">`                             | Aborts the active upload (and discards its server session) or discards completed, unfinalized tokens and clears the field. |

Programmatic API: `client.upload(input)` returns the tokens, `client.cancelUpload(element)`.
The input dispatches `nestvexa:upload` (`{ field, count }`) and
`nestvexa:upload-error` (`{ field, code }`) events. While uploading it has
`aria-busy="true"`; on failure `aria-invalid="true"`.

Every file uses the resumable session protocol: create a session, `PUT` exactly
the next chunk (with a per-chunk SHA-256 when `crypto.subtle` is available),
`POST complete` with the digest of the concatenated chunk digests. Lost replies,
network errors and 5xx responses are retried up to three times after a status
query resyncs the received byte count. Purposes with `direct: true` get a
presigned S3 `PUT` instead of chunks; the CSRF header is never sent to storage.

The writable field must be validated: `@State({ writable: true, validate:
uploadReferenceField({ max: 5 }) })`. That is a shape check only — the real
checks happen in `finalize`.

## 3. No-JavaScript fallback

```hbs
<form method='post' action='/classic' enctype='multipart/form-data'>
  <input type='hidden' name='_csrf' value='{{csrf}}' />
  <input name='files' type='file' multiple />
  <button>Upload</button>
</form>
```

```ts
@Post('classic')
async upload(@Req() request: Request, @Res() response: Response) {
  try {
    const { files } = await this.uploads.receiveForm(request, { purpose: 'classic.files' }, response);
    for (const file of files) save(await this.uploads.finalize(request, file.token, { purpose: 'classic.files' }));
  } catch (error) {
    flash(request, error instanceof UploadError ? error.code : 'FAILED');
  }
  response.redirect(303, '/classic');
}
```

The hidden CSRF field must come **before** file inputs: file parts that arrive
before a verified token are refused without being written. A foreign `Origin`
header is refused; a missing one relies on the token plus `SameSite` cookies.
Busboy limits (files, fields, parts, header pairs, field size) and the purpose's
`maxFileSize`/`maxFiles` apply while streaming; on failure every file from the
request is deleted.

## 4. Storage

- **LocalStorage** (default): `<directory>/objects/<2-char shard>/<43-char random>`.
  Keys are validated and the resolved path must stay inside the root.
- **S3Storage**: `new S3Storage({ endpoint, region, bucket, credentials, prefix })`.
  Server-side `PUT` sends the already computed SHA-256 as `x-amz-content-sha256`,
  so the provider verifies the bytes. `presignUpload` signs `content-type` and
  `content-length`; `presignDownload` signs `response-content-disposition` and
  `response-content-type` overrides. Credentials may be a provider function for
  rotation. Implemented with SigV4 on `node:crypto` — no AWS SDK.
- **Your adapter**: implement `UploadStorage` (`put`, `open(key, range?)`, `stat`,
  `delete`, optional `presignUpload`/`presignDownload`). Never accept URLs or paths
  from requests; call `assertStorageKey`.

## 5. Malware scanning

```ts
UploadsModule.register({
  // …
  scanner: new ClamdScanner({ host: 'clamd.internal', port: 3310 }),
  purposes: {
    invoices: { types: ['pdf'], maxFileSize: 10_000_000, requireScan: true },
  },
});
```

`scan(file, signal)` receives metadata and an `open()` stream of the exact bytes
and returns `clean`, `infected` (token and bytes are deleted, `422 UPLOAD_INFECTED`)
or `error` (`503 SCAN_FAILED`, retryable until expiry). Without a scanner,
`finalize` reports `scan: 'not-configured'`, and purposes with `requireScan` fail
with `503 SCANNER_REQUIRED`. Nestvexa itself does not detect malware.

## 6. Downloads and streaming

`uploads.download` / `sendDownload` stream through backpressure (pausing the
source until the socket drains), destroy idle transfers, and support a single
`bytes=` range (`206` with `Content-Range`, `416` with `bytes */size`). Multiple
ranges, reversed ranges and malformed headers fall back to a full `200`.
`If-Range` and `If-None-Match` use a strong ETag derived from the SHA-256. Only
registered content types are sent; text types get `charset=utf-8`; anything else
is `application/octet-stream`.

## 7. Threat model summary

| Threat                                    | Control                                                                        | Test                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| Path traversal / ADS / reserved names     | Refuse separators, `..`, `:`, hidden names; random storage names               | `uploads-http`, `uploads-validation` |
| Spoofed MIME / renamed executable or HTML | Extension allowlist + declared MIME + magic bytes + markup/executable deny     | `uploads-http`, browser spec         |
| Oversize / slow bodies                    | Content-Length precheck, streaming limit, idle and total timeouts              | `uploads-http`                       |
| Zip bombs / content codings               | No decompression; `Content-Encoding` refused; declared vs actual sizes         | `uploads-http`                       |
| Token replay / other identity / tenant    | Binding+tenant hash, 404 for others, single use, TTL                           | `uploads-http`, `uploads-s3`         |
| Unauthorized finalize / purpose confusion | `authorize` per operation, purpose equality                                    | `uploads-http`                       |
| CSRF / cross-origin                       | CSRF header or first form field, exact Origin                                  | `uploads-http`, browser spec         |
| Quota exhaustion / disk fill              | Per purpose, identity, tenant, process quotas; concurrency; rate limit         | `uploads-http`                       |
| Chunk reorder/gap/duplicate/corruption    | Exact index/offset/size, per-chunk and combined digests, truncation on failure | `uploads-http`, `client-upload`      |
| Tampered temporary file                   | Size + SHA-256 re-check at finalize                                            | `uploads-http`                       |
| Header injection in downloads             | RFC 5987 encoding, ASCII fallback without quotes/CR/LF                         | `uploads-validation`                 |
| SSRF / open redirect                      | No URL fetching; static S3 endpoint; generated keys                            | `uploads-s3`                         |
| Malware                                   | Scanner hook; honest `not-configured`                                          | `uploads-s3` (clamd protocol double) |

Remaining gaps are listed in the README's production caveats.
