# Tutorial: add realtime updates

You will make a Live component refresh in every authorized browser when server
data changes, and report background-job progress to the job's owner only. The
finished code is the `/realtime` page of
[`examples/starter-live`](../../examples/starter-live/README.md)
(`src/realtime-board.ts`, `src/main.ts`), exercised by
[`tests/browser/realtime.spec.ts`](../../tests/browser/realtime.spec.ts).
Reference: the [realtime guide](../guides/realtime.md) and
[ADR 0009](../adr/0009-realtime-backpressure.md).

## How the pieces fit

Realtime in Nestvexa is **invalidation**, not state push. A component declares the
channels it depends on; the server signs a token for the channels the current
identity may read; the browser holds one SSE (or WebSocket, or polling) connection;
when your code publishes to a channel, each subscribed component re-renders
through its own authorized `$sync` route. Pushed data is never applied as state.

## 1. Install

```sh
npm install @nestvexa/realtime
npm install ws   # only for the optional WebSocket transport
```

## 2. Register the realtime module

`secrets` signs subscription tokens (1–8 secrets of at least 32 bytes; the first
signs, the rest verify during rotation). `authorizeChannel` is your read policy:

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
    RealtimeModule.forRoot({
      secrets: [randomBytes(48).toString('base64url')],
      origin: `http://127.0.0.1:${port}`,
      resolveIdentity: (request) => ({ binding: guestBinding(request) }),
      authorizeChannel: (identity, channel) =>
        channel === publicChannel || reportJobs.authorize(identity, channel),
    }),
```

The example generates a random secret per process. In production load a stable
secret from your secret store, otherwise tokens break on restart and differ
between replicas.

## 3. Give the signer to Live and enable the browser transport

Inject `RealtimeService` into the Live policy factory and set
`browser.realtime.endpoint`:

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin: `http://127.0.0.1:${port}`,
          realtime,
```

Allow `$sync` for every component that subscribes; that is the route a refresh
uses. The starter's policy allows `$mount`, `$sync`, `post`, `startReport` and
`cancelReport` for `realtime-board`.

## 4. Declare channels and publish

<!-- snippet: examples/starter-live/src/realtime-board.ts -->

```ts
  @RealtimeChannels() channels(): string[] {
    return this.jobId
      ? [publicChannel, JobRunner.channel(this.jobId)]
      : [publicChannel];
  }
```

After a change, publish to the channel. Other browsers refresh through their own
session; the acting browser already has its action response:

<!-- snippet: examples/starter-live/src/realtime-board.ts -->

```ts
// Other subscribed browsers refresh through their own authorized $sync route.
await this.realtime.publish(publicChannel, null, {
  identity: { binding: guestBinding(this.request) },
});
```

Passing the publisher's `identity` applies the per-identity publish rate limit.

Name channels after the data they guard (`orders:<tenant>`, `user:<id>`), and make
`authorizeChannel` check that the identity may read that tenant or user. Knowing a
channel name grants nothing: channels are re-authorized at subscribe time,
periodically and before delivery.

## 5. Report job progress to its owner

`JobRunner` runs jobs bound to the identity that enqueued them over a `JobQueue`
(in memory by default), with retries, leases and cancellation, and publishes
progress on a per-job channel. Handlers are registered by name, and
`reportJobs.authorize(identity, channel)` in step 2 lets only the owner
subscribe:

<!-- snippet: examples/starter-live/src/realtime-board.ts -->

```ts
  async #start(fail: boolean): Promise<void> {
    const identity = { binding: guestBinding(this.request) };
    // Two attempts: a transient failure is retried automatically.
    this.jobId = (
      await this.jobs.enqueue(identity, 'report', {
        input: { fail },
        maxAttempts: 2,
      })
    ).id;
  }
```

The view renders `job.status` and a `<progress>` element inside a
`role="status"` region, so screen readers hear updates.

## 6. Revoke on logout and permission changes

Call `realtime.revoke(binding)` when a session ends and
`realtime.closeChannel(channel)` when a permission changes, so open connections
close instead of waiting for token expiry (default TTL 15 minutes).

## 7. Optional: WebSocket transport

Session middleware does not run on HTTP upgrades, so the WebSocket transport needs
`resolveUpgradeIdentity(request)` in the module options. Then call
`await attachRealtimeWebSocket(app)` after creating the app. With the default
`transport: 'auto'` the browser asks `GET /_nestvexa/realtime/negotiate` which
transports the server offers and uses WebSocket once it is attached, falling
back to SSE and then long-polling if a proxy blocks it. Choose `'websocket'`,
`'sse'` or `'polling'` to pin one. Upgrades require the exact configured
`Origin`.

## 8. More than one replica

Pass `broker: new RedisRealtimeBroker({ host, port, password, prefix })`
(from `@nestvexa/realtime-redis/realtime`) so a publish on one replica reaches
subscribers on the others. Add `presence: { store: new RedisPresenceStore(redis) }`
so `presence()` counts viewers on every replica, and give the job runner
`queue: new RedisJobQueue(redis)` so jobs survive restarts and a job whose
worker crashed is picked up by another (handlers may run twice: make them
idempotent). Live component state needs `store: new RedisLiveStore(redis)` in
the Live options so actions can land on any replica. Redis pub/sub is
fire-and-forget: events published while a replica is disconnected are lost and
browsers refresh after reconnecting. The broker speaks plain TCP (no TLS), so
keep Redis on a private network. See
[multi-replica deployment with Redis](../deployment/multi-replica-redis.md) and
[production services](../guides/production-services.md).

`pnpm test:services` runs four replicas (Express and Fastify, SSE and WebSocket)
of [`examples/distributed-live`](../../examples/distributed-live/README.md)
against real Redis and checks cross-replica refresh, Live state continuation,
presence, reconnects and isolation in a browser.

> **Known gap:** load testing across replicas has not been done, and
> slow-consumer handling is tested at hub level only (REAL-014).

## 9. Test it

```sh
pnpm build
pnpm exec vitest run tests/realtime.test.ts tests/realtime-live.test.ts
pnpm exec playwright test tests/browser/realtime.spec.ts --project=chromium
```

The browser spec opens two isolated sessions and checks that a post by one
refreshes the other with escaped text:

<!-- snippet: tests/browser/realtime.spec.ts -->

```ts
// Bob never acted: the published invalidation triggers his own authorized refresh.
await expect(bob.locator('#realtime-feed li').first()).toHaveText(text);
await expect(bob.locator('#realtime-feed b')).toHaveCount(0);
```

It also checks forged and foreign tokens are rejected and that job progress
reaches only its owner.

## Limits

> **Known gap:** transport selection is per page, not per component (one
> multiplexed connection serves every component; REAL-004). Delivery is
> at-most-once: events published on a channel before the browser's subscription
> is established are not replayed (REAL-006). No BullMQ adapter ships; use
> `RedisJobQueue` or BullMQ directly (DATA-010, see the realtime guide).
