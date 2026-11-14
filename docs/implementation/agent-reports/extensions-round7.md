# Extensions round 7 (branch `r7-ext7`)

Scope: ledger re-audit gaps in EXT-004/EXT-006/EXT-009 (fragment cache, Early
Hints, N+1 detection), EXT-029 (mail over real SMTP), EXT-017 (ADR 0026,
example, cross-browser runs) and SEC-002 (threat-model diagrams, ASVS). All
work is in the worktree `nv-wt/ext7`; ports used 4240-4249.

## EXT-006: read-only fragment cache and 103 Early Hints

**Fragment cache (implemented).** `FragmentCache` in
`packages/cache/src/fragments.ts` renders an HBS partial (or any
`ViewEngineAdapter` view) without a layout through `RenderCache`.

- Every fragment names an explicit `key` (namespace `render:fragment.<key>`)
  and an explicit `audience`; the key is built only from `key`, `revision`,
  engine name, `locale`, `tenant`, `permissions`, asset version and `vary`.
- The template sees only its own `model()` loader result (called only on a
  miss, refresh or bypass), never the page model.
- `private` fragments are never stored unless the `RenderCache` was created
  with `cachePrivate` (then per identity binding, no SWR).
- Inherits refusal of Live snapshots, CSRF fields and signed island props,
  tag invalidation and per-key single flight. Results are `SafeHtml`.
- `renderAll()` renders several fragments concurrently with per-fragment
  statuses.
- `@nestvexa/cache` now depends on `@nestvexa/views` (dependency-free
  contract, for `SafeHtml`); `docs/architecture/package-dependency-graph.md`
  updated.
- Tests: `tests/cache-fragments.test.ts` (11 tests, real `HbsEngine`: hit/miss
  and loader skipping, layout not applied, escaping inside and trusted embedding
  in the page, model isolation, private bypass by default, opt-in private
  caching per identity, key on every scope input, validation of key/scope
  inputs, Live snapshot refusal, tag invalidation, `renderAll`, coalescing).
- Example: `examples/data-cache` now renders its catalog (tenant), footer
  (public) and account (private) partials through `FragmentCache#renderAll`;
  `tests/cache-example.test.ts` passes unchanged.
- Docs: `packages/cache/README.md` (View fragments section, API, limits),
  `docs/guides/caching.md`, `examples/data-cache/README.md`.
- Gap: no `{{#cache}}` block helper (Handlebars helpers are synchronous);
  fragments are rendered in the controller or a composer. No shared (Redis)
  `CacheStore` (unchanged).

**103 Early Hints (implemented, opt-in).**

- `sendEarlyHints(response, hints)` / `formatEarlyHint(hint)` /
  `EarlyHint` in `packages/core/src/early-hints.ts` (re-exported by
  `nestvexa`). Works on an Express response, a Fastify reply (`raw`) or a Node
  `ServerResponse`. Writes nothing for HTTP/1.0, non-GET/HEAD, after the final
  headers, or for an empty list. Links are validated: same-origin path (not
  `//`) or `https:` URL, no whitespace/control/quote/`<>`/`;`/`,`, at most 32;
  invalid input throws before anything is written.
- `ViteAssets#earlyHints(app)` and `assetEarlyHints()` (`packages/vite`):
  hashed CSS as `preload; as=style`, entry and static imports as
  `modulepreload`, `crossorigin` matching the tags (integrity); empty in
  development; relative-base URLs are left out.
- `NestvexaBrowserService#earlyHints()` / `#writeEarlyHints(response)`: the
  content-addressed client, Alpine and adapter modules; the generated
  `no-store` `boot.js` is never hinted.
- Tests: `tests/early-hints.test.ts` (17 tests: formatting and 17 injection or
  unsafe-URL refusals; raw Node server on 4240 with HTTP/1.1 103 delivery,
  HEAD/POST, raw HTTP/1.0 socket, late call, injected link; Nest Express 4241 and
  Fastify 4242 hosts; umbrella `NestvexaBrowserService` on Express 4243 and
  Fastify 4244 with and without integrity, hinted assets served `immutable`;
  `ViteAssets` production/integrity/development).
- Docs: `docs/guides/vite.md` "103 Early Hints (opt-in)" with deployability
  notes, `packages/core/README.md`, `packages/vite/README.md`,
  `packages/nestvexa/README.md`.
- Gap: no browser-side test that a browser uses the hints (only that the
  server emits them correctly); no ADR written (implemented instead).

## EXT-009: N+1 query detection

- `queryBudget()` in `packages/observability/src/queries.ts`: structural
  `record(statement)` hook (string or `{ query | sql | text }`) that ORMs call;
  per-request scope through `middleware()` (AsyncLocalStorage) or `run(label,
work)`; statements counted by normalized shape (`normalizeQuery`: literals,
  `$n`/`:name`/`@pN` placeholders, `IN` lists to `?`, casts kept); warnings
  `n-plus-one` (default limit 5 identical) and `query-count` (default 100)
  once per scope and shape, to `onWarning` or `process.emitWarning`
  (`NESTVEXA_QUERY_BUDGET`). Warnings carry the normalized shape only (max 200
  chars), never literals or parameters. `environment === 'production'` (default
  `NODE_ENV`) returns a disabled hook (no scopes, no counting).
- Tests: `tests/observability-queries.test.ts` (9 tests, including a real
  TypeORM 1.1.2 `DataSource` on sql.js with a `Logger` forwarding `logQuery`:
  N+1 loop flagged, batched query not; a Nest Express host on 4245 with two
  concurrent N+1 requests counted apart; production fully off; privacy of
  literals; throwing sink).
- Docs: `packages/observability/README.md` (N+1 section, TypeORM/Prisma/Drizzle
  wiring), `docs/guides/observability.md`.
- Gaps: only the TypeORM wiring is tested (Prisma and Drizzle snippets are
  documented, not tested); runtime island-bundle warnings are still not covered.

## EXT-004

Not addressed in this round beyond the fragment cache's tag invalidation (the
re-audit gaps on `tagChannel()` driving a Live refresh and client coalescing
tests remain open).

## EXT-029: mail over a real SMTP server

- Root devDependencies pinned exactly: `nodemailer` 10.3.1 and `smtp-server`
  3.21.3 (both MIT-0, published 2026-10-29; `smtp-server` 3.21.3 depends on
  nodemailer 10.3.1). Never runtime dependencies of `@nestvexa/mail`.
- `tests/mail-smtp.test.ts` (5 tests): a real nodemailer SMTP transporter
  through `nodemailerTransport` to an in-process `smtp-server` on 4246:
  delivered message (envelope incl. Bcc, Bcc absent from headers, From display
  name quoting, Cc, Reply-To, custom header, multipart text+HTML, Message-ID as
  delivery id, `onDelivery` event); 550 recipient rejection and refused
  connection (4247) as `TRANSPORT_FAILED` with the SMTP error as cause and no
  recipient in the message; greeting timeout against a silent TCP server
  (4248); eight header-injection attempts refused with zero SMTP connections.
- Docs: `packages/mail/README.md` (status and testing), `docs/guides/mail.md`
  (SMTP testing and transporter timeouts).
- Gaps: `nestMailerTransport` is still tested only against a structural
  stand-in (no real `@nestjs-modules/mailer` `MailerService`); no TLS or SMTP
  AUTH path tested; attachments, queueing and IDN addresses unchanged.

## EXT-017

- ADR 0026 "Consequences and limits" rewritten to match `packages/ui/README.md`
  (components now shipped, wrapper coverage, remaining HBS-only components,
  chart/field limits, combobox without no-JS fallback, cross-browser runs).
- Example: `examples/admin-i18n` `/admin/kit` now has a `uiChart` bar chart
  (active/archived products per category, with its data table, following
  archiving) and a server-validated feedback form using `uiTextField`,
  `uiSelectField`, `uiRadioGroupField`, `uiTextareaField` and
  `uiCheckboxField` (`POST /admin/kit/feedback`, CSRF-checked,
  post/redirect/get, errors via `role="alert"`, `aria-invalid`,
  `aria-describedby`), English and Arabic.
- Browser tests: three new tests in `tests/browser/admin-ui-kit.spec.ts`
  (chart rendering and data sync, feedback validation round trip with axe,
  Arabic). The whole spec (7 tests) passed in Chromium, Firefox and WebKit
  against the example on port 4249.
- Cross-browser runs (one browser at a time, on this Windows host, 2026-11-14):
  `NV_UI_BROWSERS=firefox` and `NV_UI_BROWSERS=webkit` each with
  `tests/ui-adapters.test.ts` (34/34 passed in each) and
  `tests/ui-primitives-browser.test.ts` (22/22 passed in each). No failures
  occurred, so no fixes were needed.
- Gaps: HBS-only components without React/Vue/Svelte wrappers, combobox no-JS
  fallback and manual screen-reader verification remain as before; CI still runs
  the two UI suites in Chromium only (no CI job change in this round).

## SEC-002

- `docs/security/threat-model-diagrams.md` (new, INTERNAL): seven Mermaid
  data-flow/trust-boundary diagrams (MVC, Live, Inertia, server actions,
  uploads, realtime, islands), each with a crossing → control → test table;
  linked from `docs/security/threat-model.md`, which also gained rows for
  fragment caching, Early Hints and the query budget.
- `docs/security/asvs-traceability.md`: stale 1.2.3/1.2.2/3.5.1 rows merged,
  1.3.2/3.4.3 evidence refreshed, a V1-V17 chapter applicability table
  (Implemented 2, Partial 11, Host responsibility 2, Not applicable 2) with
  named gaps (V11 no crypto inventory, V12 Redis clients without TLS, V16 no
  security audit log), an OWASP Cheat Sheet mapping (19 rows) and "Remaining
  work".
- Every cited path was checked to exist; `pnpm docs:build` passes. The
  Mermaid blocks were not rendered visually; ASVS section numbers inside
  chapters and cheat-sheet titles should be re-checked against the published
  sources. No independent review is claimed; that ledger item still needs the
  owner.

## Verification commands (this round)

See the final message of the round for exact results.
