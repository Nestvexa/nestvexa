---
'@nestvexa/realtime': minor
---

Realtime presence, rate limits, graceful shutdown and a pluggable job queue.

- Presence: optional `describePresence(identity)` returns a public member
  descriptor; `RealtimeService.presence(identity, channel)` lists distinct
  connected members for an authorized reader (403 otherwise), bounded by
  `limits.maxPresenceMembers` (default 100). Presence is per replica.
- Rate limits: `limits.subscribesPerMinute` (default 60, every attempt counts,
  including rejected tokens) and `limits.publishesPerMinute` (default 120) for
  `publish(channel, data, { identity })`; both reply 429 `RATE_LIMITED`.
- Fix: `RealtimeService` now ends open SSE, long-poll and WebSocket
  connections in `beforeApplicationShutdown`, so `app.close()` no longer waits
  on open streams before the HTTP server closes.
- **Breaking (alpha):** `JobRunner` runs over a `JobQueue` interface
  (`MemoryJobQueue` default). Handlers are registered by name with
  `register(name, handler)` and receive JSON `input`; `enqueue(identity, name,
  { input, idempotencyKey, maxAttempts })`, `get`, `cancel` and `authorize` are
  asynchronous. Owner-scoped idempotency keys, leases with renewal,
  cross-worker cancellation, `start()` polling for other processes, an
  optional `instrumentation` span `nestvexa.job.run`, and `close()` /
  `onApplicationShutdown()` that hand running jobs back to the queue.
