# Agent report: DX and docs gaps (round 8)

Branch `r8-dx8`, from main `748681d`. Rows addressed: PHASE-053, PHASE-020,
PHASE-128, REVIEW-015 / PHASE-089 / PHASE-107 (packed consumers) and PHASE-009.
Packages touched: `@nestvexa/cli` only (changeset `.changeset/cli-make-tenancy.md`).
`packages/actions` and `packages/cache` were not touched.

## PHASE-053: standalone directive reference pages

- **Implemented.** One page per directive that had none:
  [`nv-click`](../../reference/nv-click.md), [`nv-submit`](../../reference/nv-submit.md),
  [`nv-keydown`](../../reference/nv-keydown.md), [`nv-model`](../../reference/nv-model.md),
  [`nv-text`](../../reference/nv-text.md), [`nv-show`](../../reference/nv-show.md),
  [`nv-bind`](../../reference/nv-bind.md), [`nv-class`](../../reference/nv-class.md),
  [`nv-dirty`](../../reference/nv-dirty.md), [`nv-cloak`](../../reference/nv-cloak.md),
  [`nv-ref`](../../reference/nv-ref.md), [`nv-replace`](../../reference/nv-replace.md),
  [`nv-ignore`](../../reference/nv-ignore.md) (`nv:ignore` and `nv:ignore.self`),
  [`nv-target`](../../reference/nv-target.md) and [`nv-upload`](../../reference/nv-upload.md).
  `nv:init`, `nv:poll` and `nv:intersect` already had pages. The list was checked
  against `parseDirective` in `packages/client/src/protocol.ts`: 27 directive
  families, all of which now have a page.
- Each page has syntax and modifiers, server contract, security, accessibility, an
  example and a verification section linking the tests that exercise the directive.
  Every example carries a `<!-- snippet: ... -->` provenance marker pointing at a real
  example file (`examples/live-counter`, `examples/directive-lab`,
  `examples/views-tour`, `examples/starter-live`, `examples/integration-matrix`),
  so `pnpm docs:build` fails if the example drifts.
- **Index.** `docs/reference/directives.md` has a new "Directive index" table linking
  all 27 families; the first column of `docs/reference/directive-matrix.md` links each
  directive to its page.
- **Evidence.** `pnpm docs:build`: passed for the directive pages
  (`Checked 292 documents, 78 provenance snippets, ...`; the final run after all
  changes is listed under "Commands run").
- **Remaining gap.** The pages document behavior from the client source and the
  existing guides; they add no new tests. The ledger's other residuals for this row
  (re-running the phase 4 checkpoint) are outside this change.

## PHASE-020: starter-hbs form fallback

- **Implemented.** `examples/starter-hbs` has `/contact`
  ([`src/contact.ts`](../../../examples/starter-hbs/src/contact.ts),
  [`views/contact.hbs`](../../../examples/starter-hbs/views/contact.hbs)) and a nav link.
  It is a plain `<form method="post">` that works without JavaScript. The server
  validates every field (required name, email shape, length limits) and refuses
  repeated or non-text fields (`name[]=a&name[]=b`) rather than coercing them.
  Invalid input re-renders the form with `422`, the escaped submitted values,
  `aria-invalid`/`aria-describedby` per field and an error summary (`role="alert"`)
  linking to each field. Success redirects with `303` to `/contact?sent=1`. A foreign
  `Origin` gets `403`. The starter has no sessions, so there is no CSRF token; the
  README and `docs/getting-started/mvc.md` say to add one as soon as the app has
  sessions.
- **Tests.** `tests/browser/mvc.spec.ts`: the form flow with JavaScript disabled and
  enabled (422, error summary, field descriptions, escaped values, summary link,
  Enter submission, 303 result, a reload does not resubmit), cross-origin `403`,
  repeated-field `422`, accepted `303`, and the `/api/health` coexistence route (the
  row's second outstanding issue).
- **Docs.** `examples/starter-hbs/README.md`; `docs/getting-started/mvc.md` gains
  section 4 with provenance snippets of the route and the view.

## PHASE-128: multi-tenant starter generator

- **Implemented.** `nestvexa make:tenancy` (run after `init`; refused before it with
  exit code 1 and no writes). It generates `src/nestvexa/tenancy/`:
  - `tenancy.ts`: `resolvePrincipal` (the guest session) and `resolveTenant` (only the
    session's selected tenant, re-checked against `isMember()` on every request; no
    header, query or body is read), `selectTenant`, sample tenants,
    `tenancyRequestContext`, an in-memory `TenantNotesStore` and `TenancyModule`;
  - `tenant-notes.component.ts`: a Live component that resolves the kernel tenant
    through `RequestContextFactory.identity(request)` on every mount and action and
    scopes all data by it (`tenant` state is display-only);
  - `tenancy.controller.ts`: `GET /tenancy` and a same-origin, session-CSRF-checked
    `POST /tenancy/select` (303);
  - `tenancy.spec.ts`: the generated isolation test;
  - views `views/tenancy.hbs` and `views/components/tenant-notes.hbs`.
    It wires `requestContext: tenancyRequestContext` and `global: true` into the kernel
    registration (`src/nestvexa/extensions.ts`, shared with `add plugin`), passes
    `nestvexaKernel` as the third `NestvexaModule.forRoot` argument, sets
    `kernelIdentity: true` on `nestvexaLive`, adds `TenancyModule` to `liveImports`,
    registers and authorizes `tenant-notes` (`$mount`, `add`) and registers the
    controller.
- **Tests.** `tests/cli-tenancy.test.ts` (added to `test:integration`): refusal before
  init; idempotency and dry run; wiring assertions; strict `tsc`; the generated
  isolation test (3 tests) run with vitest; and a booted app (port 4302) with two
  sessions: selection form refusals (missing CSRF `403`, foreign origin `403`,
  unknown tenant `400`), tenant-scoped notes, a forged tenant header ignored, a forged
  `tenant` state update `422 STATE_LOCKED`, another session's snapshot refused, and a
  snapshot replayed after the session switches tenant refused.
- **Docs.** `docs/reference/cli.md` (command row, limits, testing), `packages/cli/README.md`.
- **Remaining gaps.** The kernel identity is wired into Live only; actions, uploads,
  realtime and Inertia must be given `kernelIdentity` by hand (documented). The
  membership rule admits every guest session to the sample tenants and the store is
  in memory (both marked "replace before production" in the generated code). The
  Fastify variant is generated but not exercised by any test. `examples/cli-generated`
  was not regenerated: no existing template changed, and the reference app does not
  include `make:tenancy`. A dedicated `init --template` set (HBS/EJS/React/...) was not
  added.

## REVIEW-015 / PHASE-089 / PHASE-107: packed consumers

- **Implemented** in `tests/pack-consumers/consumer.ts` and `bindings-check.ts`:
  - the packed actions app is now also a packed `@nestvexa/inertia` app
    (`InertiaModule.forRoot` + `@InertiaPage('Packed/Actions')`); the check fetches
    the document and an `X-Inertia` visit and takes the CSRF token from the page props
    before any action call;
  - the React hook's `run` now calls the packed `ActionsModule` and the result and the
    hook's `onSuccess` callback are asserted (the component renders once with
    `renderToString`; Node has no DOM, so re-rendering from the store subscription is
    not exercised in the packed check);
  - the Live/HBS element helper now runs: it is bound to a minimal Node `EventTarget`
    button, clicked, and `preventDefault`, `aria-busy`, `data-nv-action-state`
    (`pending` then `success`), the `nv:action` event detail and unbinding are asserted.
    The earlier standalone packed Inertia check (document, JSON visit, deferred props,
    version 409) is unchanged.
- **Docs.** `docs/guides/server-actions.md`.
- **Evidence.** See "Commands run" for the `pnpm test:pack` results.
- **Not changed.** `docs/release/architecture-review.md` still describes the old state
  of REVIEW-015; the coordinator should update it if the review document is kept
  current.

## PHASE-009: precommit hooks

- **Decided against hooks** in [ADR 0038](../../adr/0038-no-precommit-hooks.md): CI
  already runs `format:check`, `typecheck`, `lint` and the changeset policy on Ubuntu
  and Windows; a hook would add measured start-up cost on every Windows commit
  (85 s for ESLint on three files and 17 s for Prettier on one file on the loaded
  maintainer machine), an install script and two dependencies. CONTRIBUTING points to
  the ADR and allows a personal, uncommitted hook. Listed in `docs/adr/README.md`.

## Commands run

(Filled in below.)
