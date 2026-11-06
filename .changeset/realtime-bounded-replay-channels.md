---
'@nestvexa/realtime': patch
---

`MemoryRealtimeBroker` (also used locally by `RespRealtimeBroker`) bounded
replay history per channel but kept it for every channel ever published, so
per-user or per-record channel names grew process memory without bound. Replay
history is now kept for at most `replayChannels` channels (default 10,000,
least recently published evicted first). Evicted cursors replay nothing and
clients refresh, exactly like unknown cursors. `broker.replayChannels` reports
the current count.
