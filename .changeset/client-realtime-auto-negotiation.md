---
'@nestvexa/client': minor
---

The `auto` realtime transport now negotiates with the server (`GET <endpoint>/negotiate`) and falls back at runtime along the offered list, typically WebSocket → SSE → long-polling, when a transport fails twice before `ready` or stays silent for 10 s. Server rejections (WebSocket close 4003) do not trigger a fallback. Servers without negotiation keep the previous SSE → polling order.
