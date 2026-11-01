# 0023 — Uploads, temporary tokens and storage adapters

Status: accepted for the experimental Phase 6 implementation.

## Context

Phase 6 requires secure uploads for Live components and ordinary forms:
streaming limits, content validation, temporary ownership tokens, chunked and
direct-to-storage uploads, S3 compatibility without mandatory SDKs, a malware
hook, cleanup on every failure path and safe downloads, on both Express and
Fastify.

## Decision

1. **Separate opt-in package** `@nestvexa/uploads`, independent of
   `@nestvexa/live`. It reuses the Live identity contract (`binding`,
   `csrfToken`) plus an optional `tenant`, and its own `authorize(identity,
purpose, operation)` policy. The umbrella only forwards a browser endpoint.
2. **Purposes, not field names from clients.** Policies are registered per
   purpose; Live derives `<component>.<field>` from server-rendered markers and a
   closed `nv:upload*` grammar. Clients never choose URLs, limits or types.
3. **Two-phase commit.** Bytes land in a private per-process temporary directory
   and produce a 256-bit token bound (by hash) to identity, tenant, purpose, size
   and SHA-256. `finalize` revalidates everything, re-reads the bytes, runs the
   scanner and commits to storage once.
4. **One browser protocol.** Every Live upload uses sessions + exact sequential
   chunks (the last chunk may be short). Small files are one chunk. This keeps
   the client small (one code path, XMLHttpRequest for progress) and makes resume
   a status query. `direct: true` purposes return a presigned PUT instead.
5. **Raw bodies, not multipart, for JavaScript.** Raw `application/octet-stream`
   bodies with a required `Content-Length` let the server refuse oversize uploads
   before reading. Multipart (busboy) is used only for the no-JS fallback, where a
   CSRF field must precede files. Fastify needs pass-through content-type parsers
   (`configureUploads`).
6. **Validation is authoritative on stored bytes**: extension allowlist,
   declared MIME compatibility, magic bytes for binary types, strict UTF-8 without
   controls or markup for text types, and a global executable/HTML/SVG/XML deny.
   Nothing is decompressed.
7. **SigV4 on `node:crypto`** for S3-compatible storage, verified against AWS
   published vectors and an independent in-process test double.
8. **In-memory pending state.** Tokens and sessions are process-local; files are
   removed on shutdown and stale directories on start.

## Consequences

- No cloud SDK or credentials in browsers; the S3 adapter is small and auditable,
  but only the documented subset of S3 is implemented (no multipart upload API).
- Multi-instance deployments need sticky routing until a shared store exists.
- Malware detection depends on an operator-supplied scanner; the default reports
  `not-configured` rather than implying safety.
- Real AWS/MinIO and clamd runs are owner/CI steps.

## Rejected alternatives

- **Multer/@fastify/multipart for all uploads**: two adapter-specific stacks,
  harder to enforce identical limits; multipart cannot pre-reject by length.
- **Signed (stateless) upload tokens**: cannot be single-use or revoked without a
  store, and would still need server-side file ownership.
- **AWS SDK as an optional peer**: heavy for presign/PUT/GET/HEAD/DELETE only.
- **Base64 uploads through Live actions**: memory amplification and the 1 MiB
  Live payload limits.
