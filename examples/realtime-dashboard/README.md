# Realtime operations dashboard

A Nest (Express) Live dashboard driven by `@nestvexa/realtime` over
Server-Sent Events:

- **Metric tiles** (orders, revenue, latest order) shared by every viewer.
  "Record a test order" or the optional simulator publishes an invalidation on
  `metrics:global`; every open dashboard refreshes through its own authorized
  `$sync` request, without a page reload.
- **Authorized per-role channel.** Operators see an incident log on
  `incidents:ops` and can raise incidents. Every dashboard declares that
  channel, but the realtime signer only signs channels the identity may read,
  so a viewer's token never contains it, its stream never carries it and its
  page never receives incident data. Viewers cannot call `raiseIncident`
  (`403 ACTION_FORBIDDEN`) or reuse an operator's token (`403`).
- **Presence.** "Who is online" lists the pseudonyms of open dashboards.
  `@nestvexa/realtime` has no presence primitive, so this is host code: each
  dashboard sends a renderless `heartbeat` action every 3 seconds (`nv:poll`);
  a sweep drops viewers that miss heartbeats for `PRESENCE_TTL_MS` (default
  20 s) and joins/leaves invalidate `presence:dashboard`.
- **Job progress.** "Generate report" runs an owner-bound `JobRunner` job whose
  progress steps invalidate the owner's job channel.

## Run

```sh
pnpm install
pnpm --filter @nestvexa/example-realtime-dashboard... build
pnpm --filter @nestvexa/example-realtime-dashboard start   # http://127.0.0.1:3116
```

| Variable            | Default | Purpose                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| `PORT`              | `3116`  | HTTP port (the realtime origin follows it)              |
| `DASHBOARD_TICK_MS` | `5000`  | Simulated order interval; `0` disables the simulator    |
| `PRESENCE_TTL_MS`   | `20000` | Missed-heartbeat window before a viewer leaves presence |

Open the page in two browsers (or a private window), record an order in one
and watch the other. "Switch to operator (demo)" changes the session role.

The root Playwright suite starts this example on port **3116** with
`DASHBOARD_TICK_MS=0` and `PRESENCE_TTL_MS=6000` and runs
[`tests/browser/realtime-dashboard.spec.ts`](../../tests/browser/realtime-dashboard.spec.ts)
in Chromium, Firefox and WebKit (health URL `/api/health`). It covers
cross-browser refresh without reload, presence join/leave, the incident
channel negative cases (token claims, delivered channels, forged action,
stolen token), job completion, recovery after an offline/online toggle and
axe checks for both roles.

## Security notes

- Identities are anonymous guest sessions; the role is part of the binding
  (`guest-session:<sid>:role:<role>`), so switching roles invalidates earlier
  Live snapshots and realtime tokens, and `POST /role` revokes the previous
  binding's open streams. The role switch is a **demonstration**: any guest may
  become an operator, so the incident channel only carries sample data. A real
  host derives roles from its authentication.
- Channel authorization runs when tokens are signed and again when a stream
  connects; tokens are HMAC-signed (not encrypted: channel names are visible)
  and bound to the identity. Pushed event data is `null` (job channels carry
  only the job status); data only reaches a browser through its own
  authorized `$sync` render.
- Metrics, incidents, presence, jobs and sessions are process memory; the
  realtime secret and session secret are random per start. Production needs
  persistent stores, stable secrets (with rotation), HTTPS-only cookies and
  rate limits sized for heartbeat traffic (`maxRequestsPerMinute: 240` here).

## Known gaps

- **Two instances / Redis.** This example uses the default in-process
  `MemoryRealtimeBroker`, so it is single-instance. Cross-replica delivery
  through `RespRealtimeBroker` is covered only by the in-process RESP test
  double in [`tests/realtime.test.ts`](../../tests/realtime.test.ts)
  ("RESP broker (two replicas, test double server)"). A two-instance browser
  test against a real Redis was not run (it needs Docker and extra ports), and
  the demo stores would also have to move to shared storage for replicas to
  show the same data.
- **Events during an outage.** If an invalidation arrives while the browser is
  offline but its event stream is still open (Chromium keeps it open under
  `setOffline`), the resulting refresh fails with `NETWORK` and the Live client
  suspends the component until a reload. The browser test accepts either live
  catch-up or that documented recovery path, then proves later events arrive
  live.
- **Token renewal reconnects the stream.** Every rendered response re-signs the
  subscription token, and a changed token makes the client open a new event
  stream; an event published in that short gap is not replayed. The heartbeat
  is renderless to avoid a reconnect every few seconds.
- No WebSocket transport, no per-tenant channels and no persistence of
  presence across restarts.
