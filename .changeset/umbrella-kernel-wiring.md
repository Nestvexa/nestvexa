---
'nestvexa': minor
---

The umbrella wires the kernel into Live (policy registry, request context and
diagnostics), adds `nvRequest` (public request context with the CSP nonce) to every
`@Render()` model, publishes SHA-384 `integrity` metadata in the client asset manifest and
adds `browser.integrity` for integrity-checked boot and module preload tags.
