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

Runs use fast-check's random seed; a failure prints the seed and a shrunk
counterexample. Reproduce with `fc.assert(..., { seed, path })` and add the
counterexample as an explicit regression next to the property (see the
"regression:" tests). Findings from the first run are listed in the
[internal review](../security/internal-review-2026-11.md).

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

## Mutation testing (not adopted yet)

Stryker was evaluated and **not** added. Reasons: (1) the high-risk suites are
integration-heavy (real Nest servers, Chromium/Firefox/WebKit, HTTP), so each
mutant would rerun minutes of browser and server tests; a scoped run over the
parser modules alone is estimated at hours on a 2-core runner even with
`perTest` coverage analysis; (2) vitest 5 support in the Stryker runner must be
verified before pinning; (3) on this shared host the suite already runs with
one worker. The property suites with independent reference models give the
targeted fault detection QA-079 asks for on the parsers. Next step when a
dedicated runner exists: a nightly Stryker run limited to
`packages/live/src/protocol.ts`, `packages/actions/src/shared/json.ts`,
`packages/forms/src/{harden,body}.ts`, `packages/uploads/src/{filename,download,references}.ts`,
`packages/realtime/src/token.ts` and `packages/views/src/adapter-kit.ts`, with
the property suites as the test command and a reported (not yet gating)
mutation score.
