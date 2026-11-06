# Roadmap

The [master implementation specification](NESTVEXA_MASTER_IMPLEMENTATION_PROMPT.md)
defines the full scope. The [feature ledger](docs/implementation/feature-ledger.md)
and [status](docs/implementation/STATUS.md) track real delivery; the
[feature matrix](docs/feature-matrix.md) summarises it by package. This page lists
what remains, in rough priority order. Every item below is required work.

## Now: `0.1.0-alpha` hardening

- Independent security review, the full attack corpus and ASVS traceability (SEC
  rows).
- Load, soak, memory, fuzz and mutation testing (QA rows).
- A two-replica browser run through Redis (REAL-014). Live state is still
  per-process.
- Confirmed npm publication of the alpha, or registry install docs held back until
  it happens.

## Next: features named in the specification

- Shared or Redis-backed Live state store with a pluggable interface (DATA-004,
  DATA-005).
- Live `@Action({ concurrency, idempotent })`, state serializers and server-pushed
  `@OnEvent` (LIVE-004, LIVE-007, LIVE-012).
- Inertia Precognition and browser verification of client-owned features (INERT-007,
  INERT-013).
- Typed action hooks for React, Vue and Svelte (SPA-003, ACT-014).
- CLI:
  - commands `make:form`, `make:action`, `make:island`, `make:test`;
  - `add react|vue|svelte|i18n`;
  - `make:page --renderer react|vue|svelte`.

  Tracked as DX-004, DX-008 and DX-011.

- Island SSR, signed props and bundle budgets (ISLAND rows).
- CommonJS `default` export condition on every package (ARCH-016).
- A public plugin SDK with capability negotiation and an out-of-tree example (spec
  29.1).

## Later

- Queue adapters (BullMQ), ORM examples (Prisma, TypeORM, Drizzle), Passport/OIDC
  auth patterns (DATA rows).
- UI kit completion and a SPA adapter (EXT-017, EXT-020); email bridges and typed
  routes (EXT-029, EXT-030).
- Docs: visual regression of the site, external link checking, an Arabic/RTL
  quickstart, and the remaining recipes (DOC rows).

Dates are not promised. Proposals follow the [governance](GOVERNANCE.md) decision
process.
