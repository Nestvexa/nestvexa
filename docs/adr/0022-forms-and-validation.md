# 0022 — Forms, schema adapters and progressive fallback

Status: accepted for the current experimental implementation.

## Context

Phase 5 requires server-authoritative validation with DTO/class-validator and
Zod as optional peers, accessible error presentation, focus management, wizards,
drafts, repeated-submit handling and a real no-JavaScript fallback. Live already
validates transport types (`STATE_TYPE`), writability (`STATE_LOCKED`) and
per-field `validate` callbacks, and runs Nest pipes on `@ActionInput`. The
client grammar deliberately allows only top-level state identifiers in
`nv:model`. Validation had been written by hand in each component (see the
projects board).

## Decision

1. **New package `@nestvexa/forms`** with a framework-neutral main entry and a
   `./live` subpath. Live is an optional peer, so controller-only apps do not
   need it, and the Live runtime gained only one additive export,
   `describeLiveState(component, field)`, which lets integrations refuse
   members that are not declared `@State`.
2. **One adapter contract** `validate(input) → { ok, value } | { ok, errors }`
   with stable dotted error paths and `_form` for form-level messages. Zod is
   consumed structurally (`safeParseAsync`) and never imported, avoiding a
   second Zod copy and type coupling in published declarations.
   class-validator/class-transformer are loaded by dynamic `import()` on first
   use; defaults are `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`
   and `enableImplicitConversion: false`.
3. **Hardening before any adapter**: a detached plain-JSON copy with prototype
   key, accessor, type and resource-bound checks. Built-in adapters harden
   again, so calling an adapter directly cannot bypass it. Nothing is coerced.
4. **Live integration is a function, not a decorator**: `validateLive` and
   `validateField` run inside the action or `afterUpdate`, read declared state
   only, and write a **read-only** error bag. No new protocol, route or client
   directive is introduced; obsolete validation is handled by the existing
   per-component serialization and revision checks.
5. **Focus management in the client**: after an `nv:submit` response that
   advanced the revision, focus the first available, owned
   `[aria-invalid="true"]` control in the submitted form unless focus moved
   during the request (body or component-root focus counts as unmoved). About
   160 gzip bytes; well inside the 48 KiB budget.
6. **No-JS fallback through ordinary Nest routes**: `submitForm` returns a value
   for `@Redirect()` (`303`), so Express and Fastify behave identically without
   platform-specific response code. CSRF verification is mandatory and constant
   time; optional `Origin`/`Sec-Fetch-Site` checks are defense in depth; errors
   and remembered input are session-stored and read once; flash messages use
   the session key shared with `flashLive`.
7. **Repeated submits**: Live relies on the client's single pending submit and
   server revisions. No-JS forms may opt into single-use submission tokens with
   a ledger whose atomic `claim` runs before the session check (sessions may be
   shared objects or racing copies); duplicates wait for and replay the first
   redirect.
8. **Wizards and drafts are pure server primitives** with JSON state:
   `finish` re-validates every step regardless of claimed progress; drafts
   require explicit consent, are owner-keyed by host identity, bounded, expiring
   and saved with compare-and-set versions.

## Rejected alternatives

- **Dotted `nv:model` paths for repeaters**: would loosen a client security rule
  and the Live state model; repeaters use actions/child components in Live and
  bracket names in no-JS bodies.
- **Client-side validation generated from schemas**: duplicates authority; out
  of scope for this phase (the server always validates).
- **A `@Validate` decorator wrapping actions**: hides control flow and cannot
  express per-field updates from hooks; explicit calls keep early returns visible.
- **Trusting `qs` to drop prototype keys**: silent; the guide recommends flat
  urlencoded parsing so the hardening layer rejects such keys loudly.
- **Importing Zod types in declarations**: would force consumers without Zod to
  install it to type-check.

## Consequences and limits

Limits: depth 8, 200 keys per object, 10 000 characters per string, 500 items
per array, 5 000 nodes (configurable within ceilings); 100 error paths × 5
messages × 500 characters; old input ≤ 16 KiB; drafts ≤ 64 KiB by default.
`MemorySubmissionLedger`, `MemoryDraftStore` and the example throttle are
single-process. File fields are not covered (Phase 6). The example auth policy
is illustrative only. Tests: `tests/forms-*.test.ts`,
`tests/client-form-focus.test.ts`, `tests/browser/forms.spec.ts`.

## Amendment (v1): derived hints, form state object, actions bridge

- Client hints are now derived (`zodHints`, `classValidatorHints`,
  `hintsFromJsonSchema`) as conservative conveniences only: rules that cannot
  be expressed exactly in HTML (regex flags, alternation, inner anchors) are
  dropped so the browser is never stricter than the server, and the server
  still validates every submission. Zod patterns are opt-in because Zod's
  JSON Schema export drops regex flags.
- `defineForm` adds a single JSON form-state object (values, baseline,
  errors, touched, dirty, submitted, pending). File fields hold
  `@nestvexa/uploads` references and upload errors are mapped structurally,
  so neither package depends on the other.
- `actionSchema(adapter)` exposes any adapter as a `safeParseAsync` schema for
  `@nestvexa/actions`; `FormValidationPipe` is a Nest pipe. Forms and actions
  still do not import each other.
