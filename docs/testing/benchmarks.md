# Benchmarks (`pnpm bench`)

[scripts/bench.mjs](../../scripts/bench.mjs) compares Nestvexa against
baselines on the same data and the same Handlebars templates
([tests/bench/views](../../tests/bench/views)). It needs `pnpm build` and
Chromium (`pnpm exec playwright install chromium`). It writes
`artifacts/reports/benchmark.json`, which records the host, Node, CPU and
browser versions with every result.

Each target runs in its own process ([tests/bench/server.ts](../../tests/bench/server.ts),
started through `tsx` with `--expose-gc`). The benchmark process generates the
load, so load generation never shares the measured event loop. The targets
are:

| Target             | What it is                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nestvexa-hbs`     | `NestvexaModule` MVC page (`@Render`), plus a Live list component with a no-op action                                                                              |
| `plain-hbs`        | plain NestJS + Express, with Handlebars registered as the Express view engine (the Nest MVC recipe), the same layout and compiled templates, and a JSON POST route |
| `nestvexa-inertia` | `@nestvexa/inertia` page                                                                                                                                           |
| `plain-inertia`    | a hand-written responder for the official Inertia protocol, as an official server adapter implements it (no first-party NestJS adapter exists)                     |

Scenarios: `hbs-adapter`, `cold-render`, `ssr-throughput`, `noop-action`,
`bytes`, `components` and `dom-patch` (described at the top of the script).
Select scenarios with `BENCH_SCENARIOS=a,b`. Set the load phase with
`BENCH_DURATION_SECONDS` (default 10) and `BENCH_CONNECTIONS` (default 10).
`BENCH_PORT` defaults to 4210; the DOM fixture uses the next port.

The nightly workflow (`bench` job) runs every scenario on `ubuntu-latest`
with Node 24 and uploads the report as `nightly-bench`. Results are recorded
for comparison between runs, not gated: hosted runners are shared, and a
wall-clock gate there would be flaky. The morph complexity gate is a ratio
(it does not depend on the host) in
[tests/morph-scaling.test.ts](../../tests/morph-scaling.test.ts).

## Recorded run (2026-11-14)

Raw data: [bench-evidence-2026-11-14.json](../implementation/bench-evidence-2026-11-14.json).

Host: a Windows 11 laptop (i7-1165G7, 8 logical CPUs, 16 GB of RAM, about
0.5 GB free), Node 24.13.0 and Chromium 156. Several other engineers' test
suites were running on the same machine. These numbers compare targets
measured within one run; they are not absolute performance figures.

| Measurement                                  | Nestvexa                         | Baseline                                |
| -------------------------------------------- | -------------------------------- | --------------------------------------- |
| Boot until listening                         | 19.2 s                           | 11.0 s (plain Nest + HBS)               |
| First request after boot, 50 rows            | 131 ms                           | 60 ms                                   |
| Warm sequential request, p50 / p99           | 7.3 / 22.3 ms                    | 1.5 / 3.0 ms                            |
| HBS page throughput (10 connections)         | 369 req/s, p99 114 ms            | 1,061 req/s, p99 34 ms                  |
| Inertia first visit (HTML)                   | 1,396 req/s, p99 28 ms           | 2,171 req/s, p99 19 ms (official-style) |
| Inertia visit (X-Inertia JSON)               | 1,415 req/s, p99 25 ms           | 3,412 req/s, p99 12 ms (official-style) |
| No-op action: Live action vs plain JSON POST | 272 req/s, p50 32 ms, p99 117 ms | 996 req/s, p50 8 ms, p99 36 ms          |

These are from the second run, with `views.cache: true` for Nestvexa. The
first run, at the default `views.cache: false`, gave 93 req/s. The baseline
compiles its templates once, so the cache must be on for a fair comparison.

Serialized bytes (raw / gzip):

| Rows  | Live mount HTML | Live action reply | Inertia JSON page | Inertia HTML page | Plain HBS page   |
| ----- | --------------- | ----------------- | ----------------- | ----------------- | ---------------- |
| 10    | 2,256 / 594     | 1,546 / 577       | 830 / 341         | 1,229 / 525       | 1,369 / 469      |
| 100   | 19,688 / 2,878  | 13,218 / 2,798    | 6,848 / 1,432     | 8,147 / 1,706     | 10,267 / 1,830   |
| 1,000 | refused, `413`  | -                 | 68,750 / 12,107   | 79,049 / 12,588   | 101,869 / 15,496 |

A Live component holding 1,000 rows (about 70 KB of state) is refused by
design: Live state is bounded by `LIVE_LIMITS` (64 KiB). The action reply
carries the rendered HTML together with the state, so it is roughly twice
the size of an Inertia page for the same data.

Concurrently active components (each one is a separate user with a 10-row
list; one action each, at most 100 connections):

| Components | Mount wave | Action wave | Action p50 / p99 | Heap per component after GC |
| ---------- | ---------- | ----------- | ---------------- | --------------------------- |
| 10         | 82 ms      | 80 ms       | 76 / 79 ms       | not meaningful (GC noise)   |
| 100        | 309 ms     | 302 ms      | 266 / 294 ms     | about 27 KB                 |
| 1,000      | 1.9 s      | 2.2 s       | 203 / 432 ms     | about 8 KB                  |

DOM patch (keyed table, every row's text changed and a checkbox per row,
median): 14 ms for 100 rows, 128 ms for 1,000 rows and 1,235 ms for 5,000
rows. Growth is close to linear (about 9x for 10x the rows). Before the fix
in this round, the checkbox case was quadratic.

What these numbers show on this host: Nestvexa's MVC page and Live action
paths cost about three to five times the plain-Nest baseline per request,
and Inertia about 1.5 to 2.4 times the hand-written responder. Neither
overhead has been profiled yet. Finding where it goes is the next step
(section 18.2 asks to optimize from profiles). No budget is claimed as met.

## Not measured yet

These items from section 18.2 have no benchmark:

- React, Vue and Svelte SSR server throughput (only HTML rendering through
  Handlebars and Inertia responses are measured);
- build output size over time (`pnpm size:check` gates the current client
  bundle only);
- database requests caused by rendering;
- two replicas plus Redis compared with one process;
- disconnect, reconnect and graceful-shutdown timing under load;
- Playwright tracing or performance-panel profiles in CI.

The initial budgets in [scripts/load.mjs](../../scripts/load.mjs) have not been
revised, because no measurement from a stable, pinned host exists yet.
