---
'@nestvexa/realtime': minor
---

The slow-consumer bound is drain-aware. A congested SSE stream or WebSocket
(over 256 KiB buffered) pauses that connection instead of closing it. Later
events queue in order and are written once the transport drains. The
connection closes as `slow-consumer` only after `drainTimeoutMs` (new,
default 10 s), or when its queue exceeds `queueLimit` (default raised from 64
to 1024) or `maxQueuedBytes` (new, default 4 MiB). `RealtimeSink` gains an
optional `onDrain`.

`attachRealtimeWebSocket` claims upgrades for its own path before other
`upgrade` listeners. It now shares a port with a host `@WebSocketGateway`
served by Nest's `WsAdapter`.

New `RealtimeNotifications` (with `MemoryNotificationStore` and the
`NotificationStore` interface) provides user-scoped notifications with an
unread count, on a private `notify:<digest>` channel per recipient.
