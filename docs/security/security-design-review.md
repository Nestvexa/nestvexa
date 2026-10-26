# Preliminary security design review

Date: 2026-10-26. Result: **NOT YET READY — BLOCKERS**. Scope: internal implementation checkpoint; no independent penetration test, external audit or ASVS certification occurred.

## Reviewed boundaries

The MVC path retains normal Nest routing. Template files/helpers are trusted application code; data interpolation escapes by default. Root-relative resolution and realpath containment reject traversal and escaping symlinks. Production precompilation accepts trusted build artifacts rather than client-named modules. Core config rejects unknown/accessor/prototype hazards. These controls have scoped unit/integration fixtures, not proof against every context or filesystem attacker.

Live now executes bounded JSON parsing, opaque host-bound state, expiry/revision locks, explicit action/state registries and generated Nest handlers in real Express/Fastify tests. Cookie-backed browser tests reject forged origins, absent CSRF, cross-session references and stale revisions. The stored public state excludes services. Memory storage is single-process. Failed action/render callbacks invalidate state because external effects cannot be rolled back or safely retried. Capacity remains bounded while expired/revoked callbacks are in flight. Client grammar rejects executable action expressions, checks response identity/revision and preserves explicit ownership boundaries in the tested slice. These scoped passes are not the complete release security gate.

The Alpine adapter exposes call/get/set through the host's public magic API and cleanup lifecycle. It rejects unsupported host versions or conflicting client installation and restricts coexistence to ignored subtrees. The real CSP build passed its initial Chromium flow. Full detach/reparent and multi-framework ownership coverage remains open. Accessibility scanning found a real target-size issue; external sample CSS was corrected without suppressing the rule, and verification is pending.

## Findings and release blockers

| Finding                                                                                                                    | Severity              | Required resolution                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Full Nest parity/security corpus remains incomplete despite real both-adapter subset passes                                | P1 release gate       | Extend ordering, scopes, metadata, versioning and negative tests to every claimed integration |
| Initial nullable-document compile errors are fixed; complete browser/DOM proof remains open                                | P1 release gate       | Finish lifecycle, input, nested ownership, network reordering and browser matrix acceptance   |
| Cookie/session origin, CSRF and cross-session/replay subset passes; full tenant/revocation corpus remains open             | P1 release gate       | Cover every lazy, event, store, upload and distributed identity boundary when implemented     |
| Component locks do not provide durable exactly-once business effects                                                       | P1 product boundary   | Document no unsafe retries; add opt-in durable business idempotency and failure/restart tests |
| Linux and full browser/Node matrices remain unrun                                                                          | P1 release gate       | Use working Linux infrastructure; run supported Node, Firefox/WebKit and release matrix       |
| Full uploads, Inertia script JSON, alternate engines, universal actions and realtime security surfaces are not implemented | P1 unmet requirements | Implement and test before claiming full ecosystem readiness                                   |
| Privacy, limits, mutation/fuzz/coverage, independent review and full ASVS applicability evidence are incomplete            | P1                    | Produce reproducible reports tied to reviewed source and fix all release-blocking findings    |

These are tracked risks and unmet gates, not claims that each unverified path has a demonstrated exploit. A concrete exploit, if found, requires its own reproduction/regression record.

## Dependency and distribution history

The dependency audit found a high Multer advisory in the Nest Express tree; upstream fixes it in 2.5.0. Workspace and external-consumer overrides were added and a clean audit rerun reported. The new npm/pnpm checker initially failed on missing workspace links for Alpine; the subsequent seven-package run passed both external strict-TypeScript and real MVC/Live consumers, with zero exits for install, compile, HTTP smoke and Node package imports. Its report timestamp is `2026-10-26T11:07:39.375Z`. Preserve initial failures and successful scoped reruns. Repository overrides do not automatically protect downstream apps, and later edits still require repacking.

## Review limitations and next evidence

No production secrets or real customer data are needed for the fixtures. Credentials must not appear in logs, tarballs or diagnostics. Host operators own authentication/session infrastructure, TLS/proxy policy and deployment hardening; a framework boolean cannot install those guarantees. Before release, conduct an independent review of the [threat model](threat-model.md), [ASVS mapping](asvs-traceability.md), complete attack corpus and immutable build/test/package reports. The current review author is an internal coding-agent role; no human reviewer identity is invented.
