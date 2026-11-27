---
'@nestvexa/observability': minor
---

The development panel shows browser morph timing and network batches (Live
requests per component with request and response bytes and trace ids), cache
hit/miss per namespace and Inertia page props (redacted). Browser timings are
sent by `devtoolsReporter` from the new `@nestvexa/observability/devtools-client`
entry to a development-only `POST <path>/client` endpoint that requires the host
`authorize` check, same-origin JSON and the `x-nestvexa-devtools` header.
`DevtoolsInspector` gains `cacheEvent` (for `@nestvexa/cache` `onEvent`), `page`
(for the Inertia `inspector` option) and `clientReport`; `data.json` adds
`browser`, `cache` and `pages`.
