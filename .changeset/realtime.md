---
'@nestvexa/realtime': minor
'@nestvexa/live': minor
'@nestvexa/client': minor
'nestvexa': minor
---

Add `@nestvexa/realtime`: identity-bound HMAC subscription tokens, SSE, long-poll
and optional WebSocket transports, a memory broker with replay, a Redis-protocol
broker and an owner-bound job runner. Live components declare channels with
`@RealtimeChannels()`; events refresh them through their authorized `$sync`
route.
