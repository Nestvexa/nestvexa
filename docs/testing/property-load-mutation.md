# Property, load and mutation testing

## Property-based tests (`pnpm test:property`)

fast-check 4.10.2 (exact root devDependency). Suites are part of
`pnpm test:security` and the default `pnpm test` run.

| Suite                                    | Boundary                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `tests/property-live-protocol.test.ts`   | Live envelope and state budget (independent byte/node/depth model), snapshot tokens, text-stream request, download effects     |
| `tests/property-realtime-token.test.ts`  | Realtime token tampering, identity/expiry binding, rotation, channel grammar, broker replay bounds                             |
| `tests/property-uploads.test.ts`         | Client filenames, name header decoding, `Content-Disposition`, RFC 9110 Range, upload references, storage keys, text validator |
| `tests/property-uploads-http.test.ts`    | Multipart and raw upload routes over real Express HTTP: no 5xx, valid names only, no temp-file leaks                           |
| `tests/property-view-paths.test.ts`      | View ID/reference resolution and traversal through HBS, EJS, Pug and Nunjucks views, partials and includes                     |
| `tests/property-input-admission.test.ts` | Server action JSON admission, output serialization, fingerprints, form hardening/bracket bodies, log redaction                 |
| `tests/property-i18n.test.ts`            | ICU message parser/renderer, escaping, plural/select, locale/Accept-Language/cookie negotiation                                |
| `tests/property-inertia.test.ts`         | Inertia headers, every redirect validator, request-derived locations, script-embedded page JSON                                |
| `tests/property-client-runtime.test.ts`  | Browser Live client in a real browser: directive grammar, fragment validation, morph invariants, hostile server replies, mount |

Runs use fast-check's random seed; a failure prints the seed and a shrunk
counterexample. Reproduce with `fc.assert(..., { seed, path })` and add the
counterexample as an explicit regression next to the property (see the
"regression:" tests). Findings from the first run are listed in the
[internal review](../security/internal-review-2026-11.md).

Every suite's run count is a baseline multiplied by
`NV_PROPERTY_RUNS_MULTIPLIER` (an integer from 1 through 100, default 1;
invalid values fail). The nightly workflow uses 10.

### Browser runtime fuzzing

`tests/property-client-runtime.test.ts` serves the built
`packages/client/dist` modules to a real browser (Chromium by default;
`NV_FUZZ_BROWSERS=chromium,firefox,webkit` for all three, as in the nightly
workflow; it needs `pnpm --filter @nestvexa/client build` first). fast-check
generates inputs in Node and each run is evaluated in the page. The page has no
CSP on purpose: if a hostile handler got into the live DOM it would run, and
every payload calls `nvPwn()`, which must never be recorded. The oracles do not
reuse client code:

- **Directive grammar.** Generated `nv:` names (known bases, unknown bases,
  modifiers, unicode, malformed prefixes) and values (expressions,
  prototype keys, JSON, long strings). `parseDirective` returns plain JSON data
  or throws a `DIRECTIVE` error, gives the same result twice for the same input,
  and accepts only names with a known base.
- **Fragment safety.** Mixed plain and hostile fragments (script-capable
  elements, foreign namespaces, real `on*` handlers, `srcdoc`, executable URLs
  hidden with entities, tabs, newlines, control characters, `&colon;` and
  mixed case). Anything the browser would treat as active content (judged with
  the WHATWG URL parser and the element's own event handler properties) must
  be rejected with `HTML`. After an accepted morph, the live DOM has no active
  content.
- **Morph invariants** (plain fragments, keys drawn from a small set so
  duplicates are frequent). The morph throws `HTML` exactly when sibling keys
  are duplicated, and the DOM is then unchanged. Otherwise the result is
  DOM-equal (`isEqualNode`) to the server fragment, keyed elements keep their
  identity, and a second identical morph causes zero `MutationObserver`
  records (idempotence).
- **Hostile replies through `createLiveClient`.** Transport faults (non-2xx,
  426, wrong content type, invalid JSON or UTF-8, a foreign protocol header,
  oversized bodies) and envelope mutations (requestId/revision/id/name
  mismatches, unsafe redirects, invalid events, downloads, realtime tokens,
  invalid snapshots, bad state keys, `__proto__` payloads, renderless with
  HTML, arbitrary field replacement). Each case must either apply atomically
  (DOM, snapshot/revision markers and state equal the reply) or reject with a
  classified client error and leave everything unchanged. Replies that are
  well formed and carry plain HTML must apply. The page never navigates and
  `Object.prototype` stays clean.
- **Mount fuzz.** Components with random owned directives are mounted, then
  click, keydown, input and change events are fired at every element.
  `mount()` never throws, every request goes to a same-origin
  `/_live/fuzz/<identifier>` URL, and no uncaught page error occurs.

## Load and memory (`pnpm load`)

[scripts/load.mjs](../../scripts/load.mjs) (autocannon 8.0.0) requires a prior
`pnpm build`, uses ports 3320–3321 by default and writes
`artifacts/reports/load.json` ([format](../release/evidence-formats.md)).

- starter-hbs `GET /` throughput and latency, heap before/after.
- live-counter: 300 fresh-session mounts, then serial `increment` actions over
  a pool of sessions at 80% of the example's documented limits (60 requests per
  minute per identity, 1000 components), followed by a soak
  (`LOAD_SOAK_MINUTES`) with heap sampled after full GC through an IPC probe
  preloaded with `--import` (the example is unmodified).
- realtime hub: 20,000 connect/publish/close cycles in process; zero
  connections and broker subscriptions must remain.

Always gated: no errors, timeouts or unexpected statuses; heap growth ≤ 24 MiB
per server and ≤ 8 MiB for the hub. Throughput/p99 budgets are enforced by
default and can be recorded as advisories with `LOAD_LATENCY_GATE=advisory` on a
saturated machine; release runs enforce them.

Recorded run (2026-11-05, Windows, Node 24.13.0, 8 logical CPUs at 100% load
from parallel work, advisory gate): 0 errors and 0 non-2xx in every scenario;
4,673 Live actions (all 201) over a 3-minute soak with heap 24.4 → 24.3 MiB
(slope 0.05 MiB/min); starter-hbs heap growth 0.32 MiB; hub growth 0.60 MiB.
Throughput (starter 23 req/s, Live actions 15 req/s, p99 ≈ 1.2 s) reflects the
saturated host and missed the budgets as advisories; it is not a performance
claim. Evidence: `docs/implementation/load-evidence-2026-11-05.json`.

## Mutation testing (`pnpm test:mutation`)

StrykerJS 10.1.1 (`@stryker-mutator/core` and `@stryker-mutator/vitest-runner`,
exact root devDependencies) mutates the highest-risk server modules
([stryker.config.mjs](../../stryker.config.mjs)):

| Module                                       | Boundary                                                              |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `packages/live/src/protocol.ts`              | Live request/capability parsing, state cloning and structural budgets |
| `packages/live/src/store.ts`                 | Snapshot store: identity binding, revision locks, TTL, capacity       |
| `packages/live/src/runtime.ts` (admission)   | Origin, content type, identity bounds, constant-time CSRF, rate limit |
| `packages/core/src/config.ts`                | Configuration normalization and environment parsing                   |
| `packages/uploads/src/{filename,references}` | Client filenames, name headers, upload references                     |
| `packages/uploads/src/file-types.ts`         | Content checks (magic bytes, declared types)                          |

The test command is [vitest.mutation.config.ts](../../vitest.mutation.config.ts):
the unit, property and admission suites for those modules
(`tests/live-admission.test.ts` exists for this purpose: every admission check
has an accepted and a rejected neighbour). Suites that import a package's built
`dist/index.js` are redirected to its TypeScript sources so mutants are seen.

Constraints:

- Requires a prior `pnpm build` (other packages are imported from `dist`).
- Runs `inPlace`: pnpm workspace links do not survive Stryker's sandbox copy, so
  mutants are written to the working tree and restored from
  `.stryker-tmp/backup-*` afterwards. Run it on a clean checkout and stop it
  with Ctrl+C, never a hard kill. `disableTypeChecks: false` keeps Stryker from
  adding `// @ts-nocheck` banners to other files (vitest does not type-check).
- Static mutants (module-level constants such as `LIVE_LIMITS`) are ignored
  (`ignoreStatic`): each would reload and rerun every suite.
- The score is reported, not gating (`thresholds.break: null`). Reports:
  `artifacts/reports/mutation/index.html` and `mutation.json`.
- The nightly workflow runs the full scope. Locally, narrow it with
  `pnpm test:mutation --mutate <files>`; `STRYKER_CONCURRENCY` sets the worker
  count (default 2).

Recorded run (2026-11-07, Windows, Node 24.13.0, three workers on a host at
100% CPU from parallel work; 67 minutes). The full scope was too slow on this
host: the dry run alone took about 7 minutes, and the first mutants ran at
about 6 per minute. So the run was narrowed with `--mutate` to Live protocol
parsing, Live admission and upload filename/reference validation:

| File (scope)                      | Score  | Killed | Survived | No coverage | Error |
| --------------------------------- | ------ | ------ | -------- | ----------- | ----- |
| `live/src/protocol.ts`            | 82.02% | 260    | 54       | 3           | 1     |
| `live/src/runtime.ts` (admission) | 92.36% | 133    | 10       | 1           | 0     |
| `uploads/src/filename.ts`         | 81.21% | 134    | 28       | 3           | 0     |
| `uploads/src/references.ts`       | 71.60% | 58     | 21       | 2           | 0     |
| **Total** (708 tested, 38 static) | 82.74% | 585    | 113      | 9           | 1     |

After the run, tests were added for the admission survivors that could be
killed: a request without a headers object, an array content-type header, and
shutdown during authorization. The remaining admission survivors are
equivalent at this boundary. `?? ''` and its mutant both fail the content-type
and CSRF checks, and the second shutdown check is shadowed by the final one.
Store, config and file-type modules have no recorded local score yet. The
nightly job runs the full scope.
