---
'@nestvexa/realtime': patch
---

`RespRealtimeBroker` reconnects its subscriber connection with bounded exponential
backoff after a reset or server restart and restores every channel subscription.
Events published while disconnected are still not recovered (Redis pub/sub
semantics); browsers refresh authoritative state after reconnecting.
