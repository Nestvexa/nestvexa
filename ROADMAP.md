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
- Redis failover and Sentinel discovery, and cross-replica replay and identity
  locks against real Redis (DATA-004, LIVE-007). The two-replica browser run
  passed against Redis 7 on 2026-11-05.
- Confirmed npm publication of the alpha, or registry install docs held back until
  it happens.

## Next: features named in the specification

- Shared stores for server-action idempotency, rate limits and locks, and
  incremental streaming of action results (ACT rows).
- Inertia `shareOnce` sugar and error-page helpers (INERT rows).
- Remaining Live and client acceptance: morphing with teleports, shadow DOM and
  screen readers, the asset-version reload in a browser, HTML-fragment streams
  (PROT-012, PROT-018, DIR-016).
- CLI: `make:resource` with an ORM (DX-016) and non-HBS Live component views.
- An out-of-tree plugin package consumed from a tarball (spec 29.1). The
  `PluginRegistry` with manifests and capabilities exists in `@nestvexa/core`.

Shipped since the first roadmap: the Redis Live store, Live action options and
server-pushed events, Inertia Precognition, typed action hooks through codegen, CLI
scaffolding for every renderer, island SSR and bundle budgets, and the CommonJS
`default` condition on every package. See the [feature matrix](docs/feature-matrix.md).

## Later

- Queue adapters (BullMQ), ORM examples (Prisma, TypeORM, Drizzle), Passport/OIDC
  auth patterns (DATA rows).
- UI kit chart and form-field wrappers and Vue/Svelte wrapper examples (EXT-017,
  EXT-020); mail attachments (EXT-029).
- Docs: visual regression of the site, external link checking, an Arabic/RTL
  quickstart, and the remaining recipes (DOC rows).

Dates are not promised. Proposals follow the [governance](GOVERNANCE.md) decision
process.
