# Authorized text streams

Use an ordinary Nest controller for a read-only producer. Keep its component
type and stream ID as trusted route constants. Register the component normally,
authorize `$stream:summary` in the host policy, and register the browser endpoint
map described in [nv:stream](../reference/nv-stream.md).

```ts
@Post('reports/summary')
@HttpCode(200)
@UseGuards(SessionGuard)
async summary(@Req() request: HostRequest, @Res({ passthrough: true }) response: object) {
  const input = parseTextStreamRequest(request.body);
  const authorization = await this.live.authorizeStream(
    request,
    ReportComponent,
    'summary',
    { snapshot: input.snapshot, revision: input.revision },
  );
  return createTextStreamResponse({
    request,
    response,
    authorization,
    produce: async function* ({ signal, state }) {
      yield `Report: ${String(state['title'])}`;
      // Pass signal to every provider/network operation you await here.
      if (signal.aborted) return;
      yield '\nComplete';
    },
  });
}
```

`HostRequest`, `SessionGuard` and `ReportComponent` are application-owned types.
The runnable [starter](../../examples/starter-live/src/main.ts) uses a real
cookie session, a host-derived binding, CSRF token and explicit policy. Its
guest demonstration is not a production authentication system.

The normal controller executes Nest's middleware, global/class/method guards,
pipes, interceptors and filters before returning `StreamableFile`. Stream reads
do not invoke a decorated Live action or pretend that action guards have run.
Resource-level read authorization belongs in the host policy or producer's
authorized service. Producers must be read-only and cooperate with `AbortSignal`.
Nestvexa cannot reverse side effects in trusted application code.

The request has exactly `protocol: 'nestvexa-stream/1'`, a bounded request ID,
an opaque snapshot token and a nonnegative safe revision. The reference passed
to `authorizeStream` contains only snapshot and revision. Unknown keys, getters,
non-JSON objects, wrong methods, content types, origins and CSRF values fail
before production. The browser cannot choose a component class, stream method,
service, template, user or tenant. A request consumes the normal admission rate
limit once; individual chunks do not each consume that request quota.

An authorization handle captures public snapshot state and an application-local
quota scope. It re-resolves the authoritative identity and checks session/tenant
binding, CSRF, policy, snapshot lifetime, component name and revision before and
after awaiting each producer chunk. If permissions or revision change during an
await, the next data chunk is withheld. These are checkpoints, not a transaction
around arbitrary external services; revalidate ownership inside services where
their consistency requires it. Public snapshot state must not contain secrets.

Responses use `application/x-ndjson`, `Cache-Control: no-store`, `nosniff` and
`X-Accel-Buffering: no`. Configure reverse proxies to allow streaming. Each line
contains the protocol, request ID, increasing `seq`, and `type: 'text'` plus
`text`, or a final `done`/`error`. Server errors expose only `STREAM_FAILED`,
`STREAM_EXPIRED` or `STREAM_LIMIT`. Once bytes have been sent, failures are
terminal records rather than a new HTTP status. Initial failures retain normal
Nest exception handling.

Limits match the client: 8 KiB records, 1 MiB total, 4,096 chunks, 10-second
producer idle and 30-second total deadlines. Node's bounded readable stream
applies backpressure. Each application allows eight active streams, with two
per component. Separate Live registrations in the same Nest application share
that scope. These are single-process limits, without distributed fairness or
Redis coordination. Host HTTP/body/time/rate limits remain necessary.

Disconnect, cancellation, limits and Nest's `beforeApplicationShutdown` abort
production and close the stream. A producer ignoring cancellation keeps its
capacity lease until outstanding `next()` and `return()` operations actually
settle, preventing repeated cancellation from spawning unbounded orphan work.
Its external I/O still requires host/provider timeouts; JavaScript promises
cannot forcibly terminate arbitrary application code.

The [Express/Fastify corpus](../../tests/live-stream.test.ts) exercises real
HTTP delivery, policy/identity/CSRF/origin denial, stale revisions, revocation
during production, quotas, cancellation, oversized/flooding producers and safe
errors. Browser tests exercise the official default HBS/Alpine bootstrap,
literal markup, cancellation and explicit subsequent reads. See implementation
status for the exact commands executed; these tests do not accept all Phase 4
features or provide an independent security review.
