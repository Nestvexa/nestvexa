---
'@nestvexa/realtime': minor
---

Add shared presence across replicas through a pluggable `PresenceStore` (`presence: { store, ttlMs }`, `MemoryPresenceStore`), merged and re-validated in `RealtimeService.presence`. Add transport capability negotiation: `GET <endpoint>/negotiate` and `RealtimeService.transports` list the transports offered now (WebSocket only after `attachRealtimeWebSocket`), the `transports` option disables or reorders them (disabled routes answer 404), and `attachRealtimeWebSocket` refuses at startup an adapter without HTTP upgrade events. `MemoryJobQueue.claim` now takes lapsed leases first and then the oldest queued job by creation time, as documented.
