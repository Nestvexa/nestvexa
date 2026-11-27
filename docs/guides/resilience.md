# Timeouts and circuit breakers for optional services

Nestvexa's optional server-side integrations talk to services you operate:
Redis (Live state, job queue, presence), S3-compatible storage, clamd, an AI
provider and a mail transport. When one of them is down or hangs, requests
must fail quickly with the package's normal error instead of piling up behind
a dead socket. Every integration therefore has:

- a **timeout** on each call, and
- a **circuit breaker** that fails fast while the service is down and lets one
  probe through after a cooldown.

None of them retries on its own. Retrying is safe only for idempotent
operations, and the caller knows which ones are. The browser realtime client
has its own reconnect breaker, described in
[ADR 0009](../adr/0009-realtime-backpressure.md).

## How the breaker works

The breaker counts consecutive failures of the dependency:

1. **Closed.** Calls run. A success resets the count.
2. **Open.** After `failureThreshold` consecutive failures, every call fails at
   once with `CircuitOpenError` (or the package's mapped error, described
   below) for `cooldownMs`. No network call is made.
3. **Half-open.** After the cooldown, exactly one call runs as a probe, and
   concurrent calls still fail fast. If the probe succeeds the circuit closes;
   if it fails the circuit reopens for another full cooldown.

Only dependency failures count: unreachable hosts, timeouts, dropped
connections and server-side (5xx) errors. Ordinary answers never open the
circuit, because they prove the service is up. Examples are a Redis `-ERR`
reply, a 404 from S3, an infected-file verdict, a model reply that the server
refuses, and a cancelled request.

Each breaker belongs to one process. Replicas do not share breaker state:
each replica finds the outage and recovers from it on its own.

Every client has a `circuit` getter (`'closed' | 'open' | 'half-open'`) for
health endpoints and metrics. Configure the breaker with
`circuitBreaker: { failureThreshold, cooldownMs }`, or turn it off with
`circuitBreaker: false`.

| Service       | Option owner                                                              | Timeout (default)                                                                        | Breaker default  | While open                                                                                                                             |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Redis         | `RespConnection`, `RedisLiveStore`, `RedisJobQueue`, `RedisPresenceStore` | `commandTimeoutMs` 5000 per command; the connection attempt is bounded by the same value | 5 failures, 1 s  | `CircuitOpenError`; the Live store maps it to the retryable `503 STORE_UNAVAILABLE`                                                    |
| Redis pub/sub | `RespRealtimeBroker` (`RedisRealtimeBroker`)                              | `commandTimeoutMs` 5000 per PUBLISH/PING reply and per connection attempt                | 5 failures, 1 s  | `CircuitOpenError` from `publish`, `ping` and a new `subscribe`; the hub refuses the realtime connection with `503 BROKER_UNAVAILABLE` |
| S3 storage    | `S3Storage`                                                               | `requestTimeoutMs` 30000 of inactivity                                                   | 5 failures, 10 s | `502 STORAGE_FAILED`, with no request sent and the unsent upload stream closed                                                         |
| clamd         | `ClamdScanner`                                                            | `timeoutMs` 30000 per scan                                                               | 5 failures, 10 s | verdict `{ status: 'error', reason: 'unavailable' }`. The upload still fails closed.                                                   |
| AI provider   | `AiAssistant`                                                             | `timeoutMs` 20000 per turn; `toolTimeoutMs` 10000                                        | 5 failures, 10 s | the turn fails at once (`turn.failed`, detail `UNAVAILABLE`), without calling the provider                                             |
| Mail          | `Mailer` / `MailModule`                                                   | `sendTimeoutMs` 30000 per send (new)                                                     | 5 failures, 10 s | `MailError('TRANSPORT_FAILED')`; the `onDelivery` event reports `CIRCUIT_OPEN`                                                         |

### Notes per service

- **Redis.** Each `RespConnection` has its own breaker. A store or queue uses
  two connections (commands and transactions), so each one finds an outage
  separately. The cooldown is short, 1 second, because Redis restarts
  quickly.
- **Redis pub/sub.** `RespRealtimeBroker` (in `@nestvexa/realtime`, also
  exported as `RedisRealtimeBroker`) has one breaker for its publisher and
  subscriber connections, since both reach the same server.
  - _Fail fast._ Connection failures, reply timeouts and dropped connections
    count; a `-ERR` reply does not. While the circuit is open, `publish` and
    `ping` reject with `CircuitOpenError` without connecting, and so does a
    `subscribe` that needs a new subscriber connection. A `subscribe` on a
    live subscriber connection still works. The hub turns a failed
    subscription into `503 BROKER_UNAVAILABLE` for every connection waiting
    on it, then forgets it, so the next connection retries.
  - _Recovery._ The subscriber reconnects with bounded backoff (100 ms
    doubling to 5 s). While the circuit is open it waits for the cooldown
    instead of connecting, then its reconnect is the half-open probe: success
    closes the circuit and restores every channel subscription, failure
    reopens it. A publish after the cooldown can also be the probe.
  - Events published while a replica is disconnected are lost, as Redis
    pub/sub is fire-and-forget; browsers refresh after they reconnect.
    `broker.subscribed` is false while a subscriber reconnect is pending,
    which readiness checks can report.
- **S3.** Presigning never touches the network, so the breaker does not apply
  to it.
- **clamd.** An open circuit never marks a file as clean. Purposes with
  `requireScan: true` keep refusing files until clamd answers again.
- **AI.** Cancellations, and model output that the server refuses (length
  limits, unknown tools, a second tool call), never count against the
  provider.
- **Mail.** A transport call cannot be cancelled. A send that hits
  `sendTimeoutMs` is reported as `TRANSPORT_TIMEOUT`, but the transport may
  still deliver it later, so do not retry automatically. Use an outbox with
  idempotency keys if you need guaranteed delivery.

## Example

```ts
new RedisLiveStore({
  host: 'redis.internal',
  commandTimeoutMs: 2_000,
  circuitBreaker: { failureThreshold: 3, cooldownMs: 2_000 },
});

new S3Storage({
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  bucket: 'uploads',
  credentials,
  requestTimeoutMs: 15_000,
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
});

MailModule.forRoot({ transport, sendTimeoutMs: 10_000 });
```

## Evidence

[`tests/circuit-breaker.test.ts`](../../tests/circuit-breaker.test.ts)
exercises each integration against a local socket or HTTP server that fails
on demand. For each one it checks four things:

- the circuit opens after the threshold;
- while it is open, nothing reaches the server (the tests count accepted
  connections and requests);
- one probe after the cooldown closes the circuit again;
- ordinary refusals never open it.

Timeouts are checked with servers that accept connections and never answer.
The breaker code is one file, `circuit-breaker.ts`, copied into each optional
package so that they stay free of dependencies. The test also checks that the
five copies (`realtime`, `realtime-redis`, `uploads`, `ai`, `mail`) are
byte-identical. `NESTVEXA_REDIS_PORT=… NESTVEXA_REDIS_CONTAINER=… pnpm
test:services` also stops and starts a real Redis container and checks that
the pub/sub broker fails fast while it is stopped and recovers after it
starts.
