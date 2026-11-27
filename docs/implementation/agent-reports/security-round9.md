# Security and resilience gaps, round 9

Branch `r9-sec9` from main `748681d`. It closes the gaps that the final ledger
audit found in SEC-004, QA-080, QA-018 and QA-020. Ports: the servers in the
committed tests use OS-assigned ports. The manual real-Redis run used 4321
for the readiness replica and Docker host port 6401 (container
`nv-r9-redis`). This round is internal engineering work with tests. It is not
an independent security review.

## SEC-004: slow clients (slowloris, slow headers, slow bodies)

**Finding.** Nestvexa did not configure the host's Node server. Node checks
`headersTimeout` (60 s) and `requestTimeout` (300 s) only every
`connectionsCheckingInterval` (30 s). Fastify 5 sets `requestTimeout` to 0
(`fastify/lib/server.js`), so on Fastify a trickled request body was never
cut off. No doc said who owns these timeouts.

**Implemented.**

- `boundHttpServer(server, { headersTimeoutMs?, requestTimeoutMs? })` in
  `packages/core/src/http-bounds.ts`, exported from `@nestvexa/core` and the
  umbrella. It uses its own per-connection timers:
  - The request head must be complete within `headersTimeoutMs` (default
    30000, range 1000-600000). The timer starts at connection and starts
    again at the end of each response on a kept-alive connection.
  - The body must be fully received within `requestTimeoutMs` (default
    300000, range 1000-3600000). The check uses `request.complete`, so a
    handler that ignores the body is still bounded.
  - A late client gets a flushed `408 Request Timeout` and its socket is
    destroyed (forced after 1 s at most).
  - Upgraded and `CONNECT` connections leave the bound. Its `upgrade` and
    `connect` listeners are added only next to a host's own listener, so
    Node's no-listener behaviour does not change.
  - Responses already being sent (SSE, streams) are not cut off.
  - Node's own `headersTimeout` and `requestTimeout` are set to the same
    values as a second line of defence.
- `configureNestvexa(app, { http })` applies the bound to
  `app.getHttpServer()` by default, on Express and Fastify. `http: false`
  opts out.

**Tests.** `tests/slow-clients.test.ts` (in `test:security`; 15 tests) uses
raw sockets on Express and Fastify, with Live (`/_nestvexa/live/slow-probe/increment`
and `$sync`), server actions (`/_nestvexa/actions/slow/touch`) and an Inertia
guarded POST route in one app:

- A trickled head on all four routes gets 408 between 0.9 s and 3.5 s (bound
  1 s), no handler runs, and the server holds 0 connections afterwards.
- A trickled body on all four routes gets 408 between 1.4 s and 4 s (bound
  1.5 s), and no handler runs.
- A slow but bounded body (a 500 ms pause) gets 2xx and runs the handler.
- 150 slowloris sockets: all 150 are accepted and held, `/ping` and an
  Inertia visit each answer in under 1 s meanwhile, all 150 get 408, and the
  connection count returns to 0.
- A kept-alive connection's second, trickled head is bounded too.
- The Node properties are set. `http: false` leaves Fastify at
  `requestTimeout` 0 and Express at 300000, which documents the finding.
- Unit tests: option validation, first bounds kept on repeated calls, an
  upgraded socket survives past the bound, and an SSE-style response survives
  past the bound.

**Docs.** `docs/security/guide.md` has a new "Slow clients" section with the
defaults, the proxy advice and the note that Node has no connection cap.
`docs/security/threat-model.md` residual risks are updated (the stale
in-memory-only and not-fuzzed notes are replaced). The core and umbrella
READMEs and `.changeset/slow-client-bounds.md` (core and nestvexa, minor) are
updated.

**Remaining.** Node has no connection cap, and none was added. A per-IP
connection limit belongs at the proxy or load balancer, and the docs say so.
HTTP/2 servers are not covered by `boundHttpServer` (it handles HTTP/1.1 and
HTTPS). Upload routes keep their own idle timeout inside `requestTimeoutMs`,
and the stalled-upload test is unchanged (`tests/uploads-http.test.ts`).

## SEC-004: fuzzing of the adapters, islands and Alpine

All three suites use `propertyRuns()`, so `NV_PROPERTY_RUNS_MULTIPLIER`
scales them. They are listed in `test:property` and `test:security` and in
`docs/testing/property-load-mutation.md`.

- `tests/property-frontend-adapters.test.ts` (8 tests) runs the built
  React, Vue and Svelte SSR bundles (`examples/inertia-*/dist/ssr`) with
  hostile `Home` props: script breakouts, event handlers, template syntax,
  U+2028, and own `__proto__`/`constructor` keys in nested data. Invariants:
  - the `data-page` hydration payload contains no `</script` or `<!--` and
    round-trips the props exactly;
  - the markup contains no script, img, svg, iframe or object element and no
    `on*` attribute;
  - the `<` count equals a render with harmless strings, so no hostile string
    opened an element;
  - nothing is polluted.

  Unregistered component names reject with `PageNotFoundError`. Registry and
  resolver properties: only safe names are accepted, only registered names
  resolve (in all three resolvers), and unsafe glob keys throw
  `PageRegistryError`.

- `tests/property-islands.test.ts` (9 tests):
  - Server props render as one start tag with quoted attributes and no
    `on*` attribute names, the attribute round-trips the JSON, and only
    unsafe or secret-like keys are refused (as `IslandError`).
  - `serializeProps` over `fc.anything` either returns JSON or throws
    `IslandError`.
  - Closed schemas reject undeclared keys.
  - Signed props verify exactly. A changed JSON character or MAC character,
    a foreign island id, arbitrary tokens, expiry and a retired key are all
    rejected, and rotation `[new, old]` verifies.
  - The manifest and shared-context parsers never pollute prototypes.
  - In Chromium, server-rendered hostile props hydrate as frozen plain data,
    unchanged, with no script and no execution (`window.__pwned`). Hostile
    `data-nv-props` written by an attacker (including `__proto__` payloads,
    arrays, invalid JSON, `1e309` and oversize values) is refused or mounted
    as plain own data, and nothing is executed or polluted.
- `tests/property-alpine.test.ts` (5 tests) covers the `$live` bridge:
  - `state` reads reach the client only for plain names, and
    set/delete/define/setPrototypeOf always throw;
  - `entangle` stages primitives only and restores the last value for
    anything else (NaN, objects, `__proto__` payloads);
  - `on()` accepts only Live event names and delivers private copies of
    matching events only, and malformed details are ignored;
  - call/set/dispatch are forwarded unchanged (the client and server
    validate them);
  - `$live` binds only inside an `nv:ignore` subtree of a component and
    never across an island, checked over random ancestor chains.

**Remaining.** The React, Vue and Svelte browser clients are fuzzed through
the payload they read (the SSR `data-page` script) and the registry they
resolve with. Booting each framework's official client in a browser per
fuzz run is not done. The threat model states this.

## QA-080: release gate rejects conditional Playwright skips

`tests/release-gate.test.ts`:

- The browser scan now covers every `*.spec.ts` and every shared suite under
  `tests/browser/` (non-spec `.ts` helpers that specs import).
- It rejects `test.skip(`, `test.fixme(`, `test.only(`,
  `test.describe.skip|fixme|only(`, `describe.skip(`, `testInfo.skip|fixme(`
  and `test.info().skip|fixme(`, whether conditional or not.
- A self-test lists the forms that must and must not match (`test.slow()`
  and `test.describe.configure()` are allowed).
- A further check reads `playwright.config.ts` and verifies that the Firefox
  and WebKit projects ignore `*.chromium.spec.ts` and the Chromium project
  does not, and that `lifecycle-heap.chromium.spec.ts` and
  `display-forced-colors.chromium.spec.ts` exist.

The scan of `tests/browser/**` on `748681d` found no remaining offenders. The
earlier `display-accessibility.spec.ts` skips were already moved by
`748681d`. Docs: `CONTRIBUTING.md` and `docs/testing/browser-fixtures.md`
describe the `*.chromium.spec.ts` convention.

## QA-018: circuit breaker for the Redis pub/sub broker

- `packages/realtime/src/circuit-breaker.ts` is a fifth byte-identical copy.
  The header comment in all five copies now lists it, and
  `tests/circuit-breaker.test.ts` checks all five and runs the breaker suite
  on the new copy.
- `RespRealtimeBroker` (`RedisRealtimeBroker`) has new options and members:
  - `commandTimeoutMs` (default 5000) bounds connecting and each PUBLISH or
    PING reply. A timeout retires the connection.
  - Pending replies are now tracked per connection, so a dropped connection
    cannot answer the wrong caller.
  - `circuitBreaker` (default 5 failures, 1 s cooldown; `false` disables it).
  - The new `ping()` method and the `circuit` and `subscribed` getters.
  - Concurrent publishers share one connection attempt.
- **Fail fast.**
  - Connection failures, timeouts and dropped connections count. `-ERR` and
    `-NOAUTH` replies do not.
  - While the circuit is open, `publish`, `ping` and a `subscribe` that needs
    a new subscriber connection throw `CircuitOpenError` (exported from
    `@nestvexa/realtime`) without touching the network.
  - The hub turns a failed subscription into `503 BROKER_UNAVAILABLE`.
- **Recovery.**
  - The subscriber reconnect runs through the breaker. While the circuit is
    open it waits for `retryAfterMs`. After the cooldown it is the half-open
    probe: success closes the circuit and restores every channel.
  - A publish can also be the probe.
- **Hub fix.** `RealtimeHub` now shares one in-flight broker subscription
  between concurrent connections (they used to join an entry whose
  subscription was still pending or had failed). It fails all of them on
  error and forgets the failed subscription so the next connection retries
  it. A subscription that completes after every connection closed is
  released.
- **Tests.**
  - `tests/circuit-breaker.test.ts` "Redis pub/sub broker" (7 tests, against
    the RESP double behind a switchable proxy): fail fast with zero
    connections while open, one probe that recovers, a failed probe that
    reopens the circuit, a silent server bounded by `commandTimeoutMs`, an
    unroutable host bounded, NOAUTH replies that never open the circuit, a
    new subscribe that fails fast while the reconnect waits for the cooldown
    and then closes the circuit and restores delivery, and disable plus
    option validation.
  - `tests/realtime-hub.test.ts` "realtime hub broker subscriptions" (3
    tests).
- **Real Redis.** `scripts/services-check.mjs` has a new section,
  `redis-broker-breaker`, that runs `docker stop` and `docker start` on
  `NESTVEXA_REDIS_CONTAINER`. It was **not executed in this round**, because
  Docker Desktop stopped answering during the session (see below).
- **Docs.** `docs/guides/resilience.md` (table row, fail-fast and recovery
  rules, five copies), `docs/deployment/multi-replica-redis.md`, the
  realtime README, and `.changeset/realtime-broker-circuit-breaker.md`
  (realtime minor; realtime-redis, uploads, ai and mail patch, for the
  comment-only change to the shared file).
- **Remaining.** Breaker state is per process (documented). The
  `@nestvexa/cache` store guidance (the second QA-018 issue) was not touched,
  because `packages/cache` was out of scope for this round.

## QA-020: readiness and liveness example

- `RedisLiveStore` gains `ping()` (it rejects with the retryable `503
STORE_UNAVAILABLE` error while Redis is unreachable or the circuit is open)
  and a `circuit` getter. The changeset is
  `.changeset/redis-live-store-ping.md` (realtime-redis, minor).
- `examples/distributed-live` probes:
  - `GET /healthz` (liveness) checks no dependency.
  - `GET /readyz` (readiness) returns 200 with
    `{ checks: { store, broker } }` only while `RedisLiveStore.ping()` and
    `RedisRealtimeBroker.ping()` answer and `broker.subscribed` is true.
    Otherwise it returns 503 with `unavailable` or `resubscribing` for the
    failing check.
  - Each check is bounded by `READINESS_TIMEOUT_MS` (default 1000).
    Standalone replicas report `memory`.
  - The store and broker are created once, so the probe checks the
    connections that serve traffic.
- **Tests.** `tests/distributed-health.test.ts` (in `test:integration`; 2
  tests) spawns the built replica on Express and Fastify against the RESP
  double:
  - `/readyz` is 200, then 503 after Redis is stopped (with
    `store: unavailable`, and each probe answers in under 1.5 s), and
    `/healthz` stays 200;
  - `/readyz` returns to 200 after Redis starts again on the same port.

  `scripts/services-check.mjs` has a new section, `distributed-readiness`,
  for a real container. It was not executed in this round (Docker, see
  below).

- **Docs.** `docs/deployment/multi-replica-redis.md` (new "Health probes"
  section with Kubernetes probe YAML, and a checklist item),
  `docs/deployment/docker.md`, `docs/deployment/node-process-managers.md`,
  the example README and the realtime-redis README.
- **Remaining.** Readiness does not report drain (documented: add a drain
  delay in `beforeApplicationShutdown`). Client-asset readiness is not
  checked.

## Docker and real Redis

The `nv-r9-redis` container was started on host port 6401 and the first
services run began. During it, Docker Desktop stopped answering: the API
returned `500` and `docker` could not reach `dockerDesktopLinuxEngine`, with
about 1.4 GB of free RAM on the host. Docker Desktop was relaunched but did
not recover during the session. The real-Redis sections
`redis-broker-breaker` and `distributed-readiness` are therefore committed
but not executed. The same behaviour is proven against the in-process RESP
double. The coordinator should run them:

```sh
docker run -d --name nv-r9-redis -p 127.0.0.1:6401:6379 redis:7-alpine
NESTVEXA_REDIS_PORT=6401 NESTVEXA_REDIS_CONTAINER=nv-r9-redis \
NESTVEXA_SERVICES_BROWSER=0 NESTVEXA_READINESS_PORT=4321 pnpm test:services
docker rm -f nv-r9-redis
```

## Commands run (one file at a time)

- `vitest run tests/release-gate.test.ts -t "Playwright|chromium|vitest tests"`: 4 passed.
- `vitest run tests/circuit-breaker.test.ts`: 46 tests (before the per-connection fix: 45 passed, 1 failed, which led to the fix). The broker and breaker-copy subset run after the fix: 13 passed.
- `vitest run tests/realtime-hub.test.ts --testTimeout=90000`: 20 passed. At the default 15 s, the first SSE test per adapter timed out on this loaded host (cold Nest boot took about 27 s). It passed with the longer timeout and is unrelated to the change.
- `vitest run tests/realtime.test.ts --testTimeout=90000`: 14 passed.
- `vitest run tests/distributed-health.test.ts`: 2 passed.
- `vitest run tests/slow-clients.test.ts`: 15 passed.
- `vitest run tests/property-islands.test.ts`, `tests/property-frontend-adapters.test.ts`, `tests/property-alpine.test.ts`: 9, 8 and 5 passed (also at `NV_PROPERTY_RUNS_MULTIPLIER=3`; see the final message).
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: clean. ESLint on every changed file: clean. `node scripts/api-report.mjs --update`: four reports updated (core, nestvexa, realtime, realtime-redis).
