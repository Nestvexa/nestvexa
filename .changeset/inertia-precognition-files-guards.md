---
'@nestvexa/inertia': minor
---

Precognition now matches the official client for files and guard rejections.
`@Precognitive(validator, { interceptors })` runs the route's body parser (for
example `FileInterceptor`) before validating a `validateFiles()` multipart
request, and the default input merges multer's `request.file`/`request.files`
under their field names. `InertiaModule` registers `PrecognitionMiddleware`
and a never-rejecting global `PrecognitionGuard`, so 401/403/419/429 guard
rejections of `@Precognitive` routes keep `Precognition: true` and
`Vary: Precognition`, while other routes never carry the header.
