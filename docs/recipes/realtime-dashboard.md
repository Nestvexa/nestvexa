# A realtime dashboard

**Goal:** several browsers show the same metrics; when one records an order,
every open dashboard refreshes within a second, and operator-only data never
reaches viewers.

Example: [examples/realtime-dashboard](../../examples/realtime-dashboard/README.md)
(port 3116).

## How it works

Realtime in Nestvexa is **invalidation**, not data push: the server publishes a
channel name, and every component subscribed to it re-renders through its own
authorized Live request. No component state travels over the event stream.

## 1. Subscribe a component to channels

`@RealtimeChannels()` lists the channels a component wants. The signer keeps only
the channels the identity is authorized for, so a viewer's token never contains
the operators' channel:

<!-- snippet: examples/realtime-dashboard/src/dashboard.ts -->

```ts
  @RealtimeChannels() channels(): string[] {
    return [
      metricsChannel,
      presenceChannel,
      incidentsChannel,
      ...(this.jobId ? [JobRunner.channel(this.jobId)] : []),
    ];
  }
```

## 2. Authorize channels

The channel policy runs when the token is signed and again when the stream
connects:

<!-- snippet: examples/realtime-dashboard/src/dashboard.ts -->

```ts
export function authorizeChannel(
  identity: RealtimeIdentity,
  channel: string,
): boolean | Promise<boolean> {
  if (channel === metricsChannel || channel === presenceChannel) return true;
  if (channel === incidentsChannel)
    return identity.binding.endsWith(':role:operator');
  return reportJobs.authorize(identity, channel);
}
```

Register it with `RealtimeModule.forRoot({ secrets, origin, resolveIdentity, authorizeChannel })`,
pass the `RealtimeService` to the Live registration as `realtime`, and set
`browser: { realtime: { endpoint: '/_nestvexa/realtime' } }` so the boot module
opens the stream (`transport`: `auto`, `sse`, `websocket` or `polling`).

## 3. Publish after a change

<!-- snippet: examples/realtime-dashboard/src/dashboard.ts -->

```ts
  @Action() async recordOrder(): Promise<void> {
    const viewer = viewerOf(this.request);
    const orders = this.metrics.record(viewer.name);
    this.notice = `Order ${orders} recorded.`;
    // Other dashboards refresh through their own authorized $sync request.
    await this.realtime.publish(metricsChannel);
  }
```

## Security notes

- Channel names are server-chosen and opaque; never build one from user input.
- The role is part of the identity binding, and the example calls
  `realtime.revoke(binding)` when the role changes, so open streams of the old
  role close.
- Use stable `secrets` in production (the first signs, all verify, for rotation).
  Across replicas, use the Redis broker from `@nestvexa/realtime-redis`
  ([multiple replicas](../deployment/multi-replica-redis.md#realtime-across-replicas)).
- Presence in this example is host code driven by a renderless `nv:poll`
  heartbeat; `RedisPresenceStore` shares presence across replicas.

## Tests

- [tests/browser/realtime-dashboard.spec.ts](../../tests/browser/realtime-dashboard.spec.ts):
  cross-browser refresh, presence, operator-only incidents (token, refreshes and
  forged actions), job progress and recovery after a network drop.
- [tests/realtime-hub.test.ts](../../tests/realtime-hub.test.ts) and
  [tests/realtime.test.ts](../../tests/realtime.test.ts): token signing, channel
  authorization and transports.

See also: [realtime guide](../guides/realtime.md) and the
[realtime tutorial](../tutorials/realtime.md).
