---
'@nestvexa/uploads': minor
'@nestvexa/client': patch
'nestvexa': patch
---

Add the opt-in `@nestvexa/uploads` package: streaming upload limits, extension/MIME/magic-byte validation, identity-bound single-use temporary tokens, resumable chunked sessions, quotas, cleanup on cancellation/disconnect/expiry/shutdown, local and S3-compatible storage (SigV4 without an SDK, presigned direct uploads and downloads), a malware scanner hook (no scanner is bundled), a no-JavaScript multipart fallback and safe single-range downloads. The Live client gains the closed `nv:upload`, `nv:upload.progress`, `nv:upload.status` and `nv:upload.cancel` directives plus `client.upload()`/`client.cancelUpload()`; the umbrella browser boot forwards an `uploads.endpoint` option.
