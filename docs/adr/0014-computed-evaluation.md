# ADR 0014: instance-local computed evaluation

Status: implemented; acceptance requires the recorded verification checkpoint.

## Decision

Preserve synchronous `@Computed()` getters and add explicit `async: true`
zero-argument methods. The runtime prepares readers on resolved Nest instances,
validates derived JSON, and awaits async members during rendering. Default caching
uses public-state JSON keys, with optional declared state dependencies and TTL.
Results are detached on every read, and private cache entries are frozen. Entries
are bounded to 64 members and never stored in snapshots or shared across requests.

Clear caches before/after hooks and before rendering, rather than inferring
arbitrary mutations in injected providers. State-key changes invalidate reads
within a stage. Async duplicate reads share evaluation; timeouts reject after a
configurable bound and never retry. Pending work for an older key cannot replace
the new entry. Return types remain ordinary JSON/Promise types in component code.

## Alternatives and tradeoffs

Global/tenant caches were rejected because permission and invalidation keys cannot
be inferred from arbitrary service reads. Request-only lifetime without stage
invalidation could retain stale private-provider values after an action. Explicit
state dependencies reduce serialization cost but require correct host declarations;
the default conservative key includes all public state. No speculative dependency
tracking or patching of injected providers is added.
Cache keys preserve signed zero and separate string markers after bounded JSON
validation, avoiding JSON.stringify's otherwise identical encodings for -0 and 0.

Prototype decorator caches would also affect instances outside the Live runtime
and could retain values beyond its lifecycle. Own instance readers keep activation
explicit. Comparing state through ordinary JSON serialization was rejected because
getters/toJSON must not execute; the existing descriptor-based bounded serializer
is reused. This adds bounded copying/key costs per read and up to one current
value/Promise per member. No performance improvement is claimed without measurement.

Implicitly awaiting getter Promises was rejected because it hides the public
sync/async boundary. Explicit method options support Promise-returning methods
without depending on an AsyncFunction constructor name or transpiler output.
See the [legacy TypeScript decorator contract](https://www.typescriptlang.org/docs/handbook/decorators.html)
and [monotonic Node performance clock](https://nodejs.org/api/perf_hooks.html#performancenow).

Unbounded async waits were rejected; evaluation deadlines release framework
resources but do not undo/cancel external effects or preempt synchronous code.
Computed failures propagate through ordinary Nest filters and the existing token
revocation policy. Such reads should be read-only. Async cycles are not dependency
graph-resolved; deadlines bound pending cached waits when the event loop can
progress, without preempting unbounded host code. Native Promise assimilation remains
trusted server execution rather than a deserialization sandbox.

## Compatibility, failure modes and evidence

The alpha default changes repeated getter evaluation into memoized reads. Hosts
can opt out with `cache: false`. Return values become detached copies, and
undecorated overrides reject registration without evaluating getters. Async
methods cannot also be actions or writable state. Public `ComputedOptions` is
exported through both Live and umbrella roots; no wire or browser asset change.

Computed method Nest guards/pipes/interceptors/filters, routing/response metadata
and parameter extraction reject registration. They are not ordinary route calls;
silently accepting policy metadata would imply authorization that never runs.
Host route/component policies and service authorization remain the actual boundary.
Unrelated custom metadata stays allowed. Native rejected getter Promises are
recognized across Node realms using [util.types.isPromise](https://nodejs.org/api/util.html#utiltypesispromisevalue).

See the [guide](../guides/computed-values.md),
[metadata/runtime](../../packages/live/src/metadata.ts),
[evaluation engine](../../packages/live/src/computed.ts),
[unit contracts](../../tests/live-computed.test.ts),
[real Nest requests](../../tests/live-computed-integration.test.ts),
[browser scenarios](../../tests/browser/computed.spec.ts) and
[external packed consumer](../../tests/pack-consumers/consumer.ts).
Phase 4 nesting, serializers, URL/session state and other features remain separate.
