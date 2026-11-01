# Uploads example

A Nest + express-session app (port **3105**) showing `@nestvexa/uploads` with a
Live component and a no-JavaScript form.

```sh
pnpm build
pnpm --filter @nestvexa/example-uploads start   # http://127.0.0.1:3105
```

- `/` — Live `attachments` component: multiple files (`nv:upload="files"`) and a
  large PDF sent in 64 KiB resumable chunks (`nv:upload="archive"`), with
  `<progress>`, `role="status"` announcements, cancel/clear buttons and an
  **Attach** action that finalizes each token on the server.
- `/classic` — the same validation pipeline through a plain multipart form with
  a CSRF field and a 303 redirect.
- `/attachments/:id/download` — owner-checked download with Range support
  (`?inline=1` for raster images).

Files are stored under `$UPLOADS_DIR` (default: an OS temp directory), outside
any served directory. This is a guest-session demonstration: production hosts
need real authentication, a persistent session store, HTTPS cookies, a database
for `FinalizedUpload` rows and, where policy requires, a configured malware
scanner. Browser tests: [uploads.spec.ts](../../tests/browser/uploads.spec.ts).
