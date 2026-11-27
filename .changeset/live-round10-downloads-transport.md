---
'@nestvexa/live': minor
'@nestvexa/client': minor
---

Download attachments work on every replica. When the state store implements
`LiveActionCoordination` (for example `RedisLiveStore`), the body is stored
as sealed records under digests of the token, and a one-time lease consumes
it. A download URL, including one inside an idempotent replay served by
another replica, is therefore served exactly once by any replica.

`@LiveComponent({ realtime: { transport } })` chooses a component's realtime
transport (`auto`, `sse`, `websocket` or `polling`). The browser opens one
connection per transport in use, and an `auto` component negotiates and
falls back on its own connection.
