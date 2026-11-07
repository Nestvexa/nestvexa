---
'@nestvexa/client': minor
'nestvexa': minor
---

Split the Live client into a core entry and four on-demand feature chunks (`live-sort.js`, `live-stream.js`, `live-upload.js`, `live-realtime.js`, ADR 0035). A page loads a chunk only when its markup, options or an explicit `startStream()`/`upload()` call needs it; components naming an unloaded feature register once it arrives. Chunks import the entry's error class back, so ownership and `instanceof LiveClientError` keep one identity. Loading uses standard module `import()` only (nonce-only, `'self'`, `'strict-dynamic'` and Trusted Types policies work). `scripts/size.mjs` now gates the core (44 KiB gzip), each chunk and the total (60 KiB).

`nestvexa/assets` serves the chunks in the same content-addressed version and adds a SHA-384 `integrity` map to the manifest. `NestvexaBrowserService.importMap(nonce?)` and `{{nvScripts integrity=true}}` render an import map that pins every client module to its digest, so browsers refuse tampered chunks.
