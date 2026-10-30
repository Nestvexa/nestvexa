# Computed values

Computed members produce derived JSON for a Live template. They are read on the
server after authorization and never become writable snapshot fields or action
routes. Both the Live package and `nestvexa` export `Computed` and `ComputedOptions`.

```ts
import { Computed, LiveComponent, State } from '@nestvexa/live';

@LiveComponent({ name: 'totals', view: 'totals' })
export class Totals {
  @State() quantity = 2;

  @Computed()
  get doubled(): number {
    return this.quantity * 2;
  }

  @Computed({ async: true, dependencies: ['quantity'], timeoutMs: 5_000 })
  async description(): Promise<string> {
    return `${this.quantity} sample items`;
  }
}
```

Use `{{doubled}}` and `{{description}}` with normal escaped HBS interpolation.
The renderer awaits async methods before producing initial HTML or an updated
fragment. An async method may inject and await a request-scoped Nest service;
the host still must authorize its data access. There is no valid TypeScript
`async get` syntax. A promise returned by a synchronous getter is rejected;
use an explicit `async: true` method instead. Computed methods accept no arguments,
and a method cannot also have `@Action` or an action ID matching its computed name.

Computed reads are not Nest route invocations. Method-level `@UseGuards`, pipes,
interceptors, filters, routing/response decorators and parameter extraction are
rejected at registration because that metadata would not execute here. Put
authentication on the native host route, use the normal Live component/action
policies for updates, and authorize sensitive computed reads inside their service.
Unrelated custom metadata is allowed, but does not execute a policy by itself.

## Cache scope and invalidation

`cache` defaults to `true`. Each managed component instance holds at most one
current entry per computed member, with at most 64 members per component. No
module-level result cache, session cache or shared tenant cache is created.
The runtime installs readers after Nest DI resolution; creating an instance
manually does not activate runtime memoization.

By default, the cache key is validated JSON from **all declared public state**.
Changing a state field or a nested array/object causes a miss on the next read.
Internal keys preserve signed-zero distinctions and type-separate string values;
they are not browser state encodings or public protocol fields.
`dependencies: ['quantity']` narrows that key to those declared state fields.
Dependencies must be unique, top-level state names, with at most 64 entries. Private
providers, computed members, dotted paths and arbitrary getters cannot be keys.
An explicit empty list means constant within the current stage, suitable only
for a read whose result does not depend on public state. The host is responsible
for declaring every relevant dependency; private/external changes are not inferred.

The runtime clears entries before and after each lifecycle hook, before rendering,
and when resolving the same instance for another explicit invocation. Hooks,
actions and rendering therefore cannot reuse a result from an earlier stage.
Within an action, state-key changes invalidate cached reads immediately. Model
synchronization still bypasses action hooks and recomputes during rendering.
Each HTTP request resolves its normal request-scoped providers independently.

Optional `ttl` is an integer **1–60,000 milliseconds**, measured with a monotonic
clock. It limits reuse within the current stage; it never extends cache life into
the next stage or request. Async TTL begins at successful completion. Pending
identical reads coalesce until settlement or the evaluation deadline. A changed
key starts independent work; an older late result cannot replace its newer entry.
`cache: false` evaluates on every read, including concurrent async calls. Supplying
TTL/dependencies with caching disabled is an error rather than an ignored option.

Every cached value is validated and privately frozen JSON. Readers receive
independent mutable copies, so mutating a returned object does not change cached
data, public state or another caller's result. A new read is not guaranteed to
return the same object or Promise identity. Avoid side effects in derived reads;
memoization changes their evaluation count.

## Failure and security boundaries

Async `timeoutMs` defaults to **30,000**, accepts integer **1–300,000**, and applies
per actual evaluation. Expiry produces the public `COMPUTED_TIMEOUT`/504 error.
The timer is released after settlement, and failed/invalid results are evicted.
This bounds how long the framework awaits a Promise; it cannot preempt synchronous
JavaScript, undo external work or cancel arbitrary services. Use service-native
abort/deadline support for expensive I/O. Synchronous recursion is rejected;
cached pending async dependency cycles reach their deadlines while the event loop
makes progress. Unbounded host recursion or microtask loops cannot be preempted.
Keep computed
dependencies acyclic and read-only.

Computed results follow the existing JSON limits: finite primitives, arrays and
plain objects, bounded depth/nodes/bytes. Undefined, BigInt, Date, Map/Set, class
instances, accessors, prototype keys and cyclic data are unsupported. The combined
state/derived view model remains subject to the 65,536-byte JSON budget; final
HTML is bounded separately. These are DTO values, not injected service objects.
Serialization inspects descriptors instead of invoking result getters; the body
of a computed method and native Promise assimilation remain trusted server code.

Once execution has entered the state-store transaction, a computed render failure
revokes the token under the existing failure policy. The action may already have
performed an external effect; obtain authoritative state before retrying. Pure
input/guard failures before execution remain separate. Shutdown after an awaited
computed value prevents subsequent render/commit. No automatic retry is added.
Client requests cannot set a derived value or call the method as an action;
server guards, ownership, CSRF and authorization stay mandatory. All computed
values rendered into HTML are public, even when their source provider is private.

## Compatibility and evidence

This alpha change keeps `@Computed()` getter syntax and the Live wire protocol.
Memoization now defaults on for managed components; use `cache: false` for reads
that intentionally evaluate every time. Returned JSON is detached rather than a
reference to provider/state objects. Derived reads must not rely on reference
identity or mutate the original through their return value. An overriding member
must explicitly repeat `@Computed`; metadata no longer exposes an undecorated
override. Existing legacy TypeScript/Nest decorator compiler flags remain required.
Ineffective method-level Nest route/policy metadata now rejects rather than being
silently ignored. Native rejected Promises from synchronous getters are handled
before rejection, including Promises created in a different Node realm.
No new runtime dependency or browser module is introduced.

The `/init` starter renders an async activity summary on the initial HTML and
subsequent actions. [Unit tests](../../tests/live-computed.test.ts) exercise cache,
TTL, metadata, JSON and Promise boundaries. [Express/Fastify tests](../../tests/live-computed-integration.test.ts)
exercise real HTTP/DI, hook invalidation, identities, guards, CSRF, state writes,
timeouts, failure redaction and shutdown. [Browser tests](../../tests/browser/computed.spec.ts)
cover actual authorized updates, negative requests and no-JavaScript HTML. The
[packed consumer](../../tests/pack-consumers/consumer.ts) strict-compiles and
renders an async computed method from npm/pnpm-installed tarballs. Executed
results belong to the current implementation report. Remaining serializers,
server nesting and other Phase 4 features are not implemented by this API.
