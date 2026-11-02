---
'@nestvexa/i18n': minor
'@nestvexa/ui': minor
'@nestvexa/ai': minor
'@nestvexa/flags': minor
'@nestvexa/offline': minor
---

Add the Phase 14 optional extensions, none of which is a dependency of the
`nestvexa` default install:

- `@nestvexa/i18n`: allowlisted locale negotiation (query, cookie,
  `Accept-Language`), namespaced catalogs with fallback chains, an ICU
  plural/select subset over `Intl.PluralRules`, escaped interpolation, `Intl`
  formatting under an explicit time-zone policy, `rtl`/`ltr` per locale, HBS
  helpers, a request-scoped composer, a render interceptor and a deterministic
  key extractor (`nestvexa-i18n-extract`).
- `@nestvexa/ui`: unstyled accessible HBS helpers (dialog, tabs, combobox,
  toast region, sortable headers, pagination, disclosure, progress), a CSP-safe
  keyboard browser module and an optional theme with dark mode, RTL and reduced
  motion.
- `@nestvexa/ai`: a provider-neutral streaming chat interface over the existing
  authorized text streams, server-enforced single-call human approval bound to
  identity, cancellation, timeouts and audit events, plus a clearly labeled
  deterministic `TestProvider` (not an AI model).
- `@nestvexa/flags`: fail-closed server feature flags with a Nest guard, an HBS
  helper and a Live authorization wrapper.
- `@nestvexa/offline`: opt-in identity-scoped form drafts with TTL and logout
  clearing, inert read-only HTML snapshots and a reconnect flow that never
  replays actions.
