---
'@nestvexa/core': minor
'@nestvexa/vite': minor
'nestvexa': minor
---

Opt-in `103 Early Hints`: `sendEarlyHints(response, hints)` and
`formatEarlyHint(hint)` in `@nestvexa/core` write validated `Link` hints on an
Express response, Fastify reply or Node `ServerResponse` (GET/HEAD over
HTTP/1.1+ only, never after the final headers, at most 32 same-origin or
`https:` links). `ViteAssets#earlyHints(app)` and `assetEarlyHints()` list the
hashed stylesheets and modules of a production build (empty in development),
and `NestvexaBrowserService#earlyHints()` / `#writeEarlyHints(response)` cover
the content-addressed Nestvexa client, Alpine and adapter modules.
