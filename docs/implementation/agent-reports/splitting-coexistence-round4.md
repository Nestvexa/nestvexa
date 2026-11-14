# Agent report: code splitting and coexistence (round 4)

Branch `worktree-agent-a37f457da1a308d35` (based on `8fe5afd`, `main` merged in
afterwards). This work was resumed after a session restart; the sort and
splitting implementation in the first two commits was written before the
restart and reviewed, fixed and verified after it.

## BROW-004: code splitting and minimal footprint

**Implemented.** The Live client ships as a core entry plus four fixed-name
on-demand chunks: `live-sort.js`, `live-stream.js`, `live-upload.js`,
`live-realtime.js` ([ADR 0036](../../adr/0036-client-feature-chunks.md), with
amendments to ADR 0015 and ADR 0020).

- `packages/client/src/index.ts`: `loadFeature()` imports a chunk once per page
  (shared by all clients, retried after a failure). Discovery defers a marker
  whose subtree names `nv:sort*`, `nv:stream*` or `nv:upload*` until the chunk
  arrives, then validates and registers it with the full validator; a server
  response naming an unloaded feature awaits its chunk before morphing.
  `startStream()` / `upload()` load their chunk. The realtime chunk loads only
  with a configured endpoint **and** a subscribed component; endpoint validation
  still fails at `mount()`. A failed load reports `LiveClientError('NETWORK')`.
- `scripts/build-client.mjs`: the entry's literal `import('./<feature>.js')`
  becomes an external `./live-<feature>.js`; each chunk may import only the
  entry's `LiveClientError`/`parseIdentifier` (build fails otherwise), so the
  page keeps one error class and one ownership registry.
- `packages/nestvexa`: `CLIENT_MODULES` serves the chunks in the same
  content-addressed version. After merging main (kernel round 4 added the
  manifest `integrity` map and `browser: { integrity: true }`), that option now
  also renders an import map pinning every client module, because modulepreload
  does not cover dynamic imports; `NestvexaBrowserService.importMap(nonce?)`
  renders it for host-owned layouts.
- CSP: standard module `import()` only (no eval, no script injection). Works
  under a nonce-only policy, `'self'` + Trusted Types (directive lab) and
  `'strict-dynamic'` (Vite pages).
- `scripts/size.mjs`: per-file and total gates; fails on any unbudgeted dynamic
  import. Measured (gzip 9): core 38,759 / 44 KiB; sort 5,415 / 6 KiB; stream
  3,497 / 4.5 KiB; upload 4,053 / 5 KiB; realtime 2,024 / 3 KiB; total 53,748 /
  60 KiB. The equivalent single bundle measures 50,196 (over the old 48 KiB
  gate), so core-only pages transfer 23 % less Live code.

**Tests.** `tests/assets.test.ts` (catalog equals package `files`; entry has no
static imports and only literal chunk imports; each chunk's single import is
the entry; one `LiveClientError` identity across entry and chunk; SRI digests of
the bytes on the wire for Express and Fastify; sibling imports resolve inside
one version). `tests/browser/client-chunks.spec.ts` with the new
`examples/client-chunks` (port 3880) plus directive-lab, integration-matrix and
starter-live: a core page requests no chunk; `nv:sort` loads `live-sort.js`
exactly once; a tampered chunk is refused by import-map integrity and the
component stays unregistered; `nv:navigate` into a sortable page under
`'self'` + Trusted Types loads the chunk then; upload and realtime chunks load
only on their pages; stream and sort chunks load together on the activity
panel. `tests/support/live-matrix.ts` now serves chunks beside the entry so the
directive matrix exercises the real split client.

**Docs.** ADR 0036, ADR 0015/0020 amendments, `packages/client/README.md`,
`docs/guides/client-assets.md` (chunks, integrity, import map; corrected the
stale "15 files" count), changeset `client-feature-chunks.md`.

**Remaining gap.** Devtools `inspect()` stays in the core (small, shares the
registry); documented in the ADR. Import-map `integrity` is opt-in and ignored
by browsers without support. A sortable/stream/upload component registers one
round trip after boot on a cold cache (documented consequence).

## DIR-017: touch, grid and cross-list sorting

**Implemented** in `packages/client/src/sort.ts` (inside the sort chunk, within
its 6 KiB budget):

- Touch and pen: Pointer Events on handles (primary, non-mouse; 8 px move
  threshold so a tap stays a button press; `pointercancel` cancels);
  `touch-action: none` set and restored through the CSSOM (CSP-safe).
- Grids and wrapping layouts: row width read from live geometry per gesture;
  drops use the horizontal midpoint (mirrored for RTL); Alt+Left/Right move by
  cell in the visual direction, Alt+Up/Down by row; vertical lists leave
  Alt+Left/Right to the page.
- Connected lists: `nv:sort.group="key"` on same-action lists of a component;
  drag between lists, drop on an empty list or free area, Alt+Shift+Left/Right
  to the previous/next list; proposals are `{ item, lists: { key: ids } }`
  (unconnected lists still send `{ ids }`); keys unique per action, item IDs
  unique across connected lists; both lists pending during a move;
  `aria-keyshortcuts` lists the accepted shortcuts.

**Tests.** `tests/client-sort.test.ts` (grammar, RTL grid keyboard, vertical
Alt+Left/Right passthrough, grid native drag by horizontal midpoint, connected
keyboard move pending both lists, drags into connected/empty/unconnected lists,
touch/pen pointer gestures with taps, mice and cancellation ignored, a real
Chromium CDP touchscreen drag). Browser: the board in
`tests/browser/client-chunks.spec.ts` (connected columns via keyboard and
native drag, grid by cell and row, against a real Nest action that validates
the permutation) in Chromium, Firefox and WebKit.

**Docs.** `docs/reference/nv-sort.md` (grammar, interaction table, server
contract), changeset `sort-touch-grid-connected.md`.

**Remaining gap.** Touch drags in Firefox/WebKit are covered by the synthetic
Pointer Events corpus, not by a real device; manual assistive-technology
acceptance remains open (unchanged).

## VISION-017: framework page hosting an isolated Live element

**Implemented** in `examples/inertia-mixed`: `/react/live` is a React Inertia
page (`client/react/pages/LiveHost.tsx`) whose `LiveIsland` owns an empty host
`<div>`; `createLiveClient({ root: host })` owns everything inside and is
disposed in the effect cleanup. The controller passes the Live mount as a lazy
prop, so partial reloads do not remount it. `@nestvexa/client` is a new
workspace dependency of the example; Vite emits its own chunks from the
client's literal dynamic imports.

**Test.** `tests/browser/inertia-mixed.spec.ts` › "an Inertia React page hosts
an isolated Live element across Inertia visits": Inertia visit in; Live actions
are Live POSTs, never Inertia visits; React state survives Live morphs and the
reverse; `router.reload({ only: ['stamp'] })` keeps the same Live DOM node and
state; leaving and returning through Inertia remounts a fresh component with no
ownership error; one document throughout; no CSP violations, page errors or
console errors.

**Docs.** New `docs/guides/coexistence.md`, link from `docs/guides/inertia.md`,
example README.

## VISION-018: API coexistence

**Implemented** `examples/api-coexistence` (default port 3885): REST with a
route-scoped API-key guard, GraphQL (`@nestjs/graphql` 14.2.0 + `@nestjs/apollo`
14.2.0, `@apollo/server` 5.5.1, `@as-integrations/express5` 1.1.2, `graphql`
16.15.0, schema-first) with a GraphQL guard, a TCP microservice
(`@nestjs/microservices` 12.2.0, hybrid app), a `@WebSocketGateway` on
`@nestjs/platform-ws` 12.2.0 (`@nestjs/websockets` 12.2.0), and a Nestvexa page,
Live component and realtime module. All third-party API packages are pinned
devDependencies of the example only.

**Test.** `tests/api-coexistence.test.ts` (added to `test:integration`) runs the
built example as a child process in two placements (gateway on the shared port
and on its own port): REST JSON without Nestvexa session/CSP/Inertia headers and
Nest's JSON 404; REST and GraphQL guards apply to their routes only and never to
Live actions; Nestvexa still rejects a foreign Origin; GraphQL, microservice and
gateway share one domain service; Apollo CSRF prevention still applies. Passing evidence so far covers the own-port placement (6/6); the
shared-port placement's cases have not completed on this host (see Commands).

**Finding (documented, not changed).** Nest's `WsAdapter` destroys every
WebSocket upgrade on its server whose path is not a gateway path, so it cannot
share a port with `attachRealtimeWebSocket`. With the gateway on its own port,
both WebSocket servers work (tested: Nestvexa's handler accepts the upgrade and
closes a bad token with 4003, and refuses a foreign Origin). On a shared port
the test documents that the upgrade is destroyed and the example keeps Live
realtime on SSE/polling. Guide: `docs/guides/coexistence.md`, note in
`docs/guides/realtime.md`.

## Commands run (Windows, Node 24, heavily loaded shared host)

Final state after merging `main` at `928b2f1` (one test file at a time):
`pnpm install --frozen-lockfile` pass (after regenerating the browser-lab
importer entry, commit `575ec98`); all packages build; `pnpm size:check` pass
(core 39,211 of 45,056; total 54,463 of 61,440); `pnpm lint` and
`tsc -p tsconfig.tests.json` pass; `pnpm format:check` pass;
`tests/client-sort.test.ts` 74/74; the sort rows of
`tests/client-directive-combinations.test.ts` (Chromium) 7/7.

Earlier runs in this round:

- `pnpm --filter @nestvexa/client build` + `pnpm size:check`: pass after the
  merge (core 38,759; sort 5,415; stream 3,497; upload 4,053; realtime 2,287
  after main's transport negotiation; total 54,011 of 61,440).
- `pnpm lint`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`: pass before and
  after merging main (after rebuilding every package).
- `pnpm exec vitest run tests/client-sort.test.ts` (and client-stream, -upload,
  -realtime, -csp, -lifecycle, -security, client.test): pass, except a 200 ms
  window in `client-stream` "before terminal completion" missed once under load
  (stream.ts is unchanged).
- `tests/client-directive-combinations.test.ts`: the sort rows failed with
  `NETWORK` before `tests/support/live-matrix.ts` served the chunks; fixed. The
  remaining failures in that run were 30 s timeouts under load.
- `tests/assets-integrity.test.ts` (after merge): 5/6 pass, including the new
  import-map assertions on Express and Fastify; the first Express test timed
  out at 15 s on a cold start. `tests/assets.test.ts`: 72/74 pass; the two
  "native API and host guard coexistence" tests time out at 15 s on this host
  (before and after the merge).
- `tests/api-coexistence.test.ts`: the own-port placement passes 6/6. The
  shared-port placement did not start within the fixture deadline under load
  in the runs I could make; started by hand (same build, same env) it serves
  normally after 3+ minutes, so its six cases are **not yet verified by a
  passing run**.
- Playwright (`playwright.local.config.ts`, ports 3880–3884):
  `client-chunks.spec.ts` Chromium 6/6 and WebKit 6/6; Firefox 4/6 (the board
  and Trusted Types cases timed out while _opening the page_, a browser start
  failure under memory pressure, not an assertion). `inertia-mixed.spec.ts`
  VISION-017 case passes in Chromium, Firefox and WebKit; the other
  inertia-mixed cases pass except one Firefox cross-root navigation timeout.

## Notes for the coordinator

- Root `playwright.config.ts`: new webServer for `@nestvexa/example-client-chunks`
  on 3880. `tests/browser/client-chunks.spec.ts` also uses directive-lab (3360),
  integration-matrix (3123) and starter-live (3102); the inertia-mixed spec uses
  its existing 3109 entry.
- `package.json`: `tests/api-coexistence.test.ts` added to `test:integration`;
  it needs `pnpm build` (the example's `dist/main.js`) and ports 3886–3892.
- `pnpm-lock.yaml`: adding `@nestjs/microservices`/`@nestjs/websockets` (optional
  peers of `@nestjs/core`) changes the peer suffix of `@nestjs/core` for every
  importer. Expect conflicts; resolve by taking either side and running
  `pnpm install`. As in any Nest app with those packages installed, Nest now
  finds them at init in this workspace (no gateways or microservices are
  registered elsewhere, so behavior is unchanged).
- `pnpm install` warns about the ignored build script of `@apollo/protobufjs`
  (an optional postinstall check); not needed.
- ADR renumbered to 0036 (main took 0035).
