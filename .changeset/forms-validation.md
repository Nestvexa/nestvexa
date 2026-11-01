---
'@nestvexa/forms': minor
'@nestvexa/live': minor
'@nestvexa/client': minor
---

Add `@nestvexa/forms`: hardened input, a schema adapter contract with Zod 4,
class-validator and custom adapters (optional peers, loaded only when used),
stable dotted error paths with localizable messages, accessible field and
summary view helpers, touched/dirty/submitted tracking, repeater and nested-path
helpers, a multi-step wizard, consent-gated versioned drafts, and a no-JS POST
fallback (`submitForm`) with constant-time CSRF verification, `303` redirects,
read-once errors/old input, flash messages and single-use submission tokens.
`@nestvexa/forms/live` adds `validateLive`/`validateField` for Live components.
Live exports `describeLiveState`; the client focuses the first invalid field of
a submitted form unless the user moved focus.
