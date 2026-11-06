---
'@nestvexa/live': minor
---

Add the pluggable `LiveStateStore` interface. The Live runtime and factory now
accept any store implementing `create`, `peek`, `transaction`, `revoke`,
`delete` and `close` (synchronous or asynchronous) instead of requiring a
`MemoryLiveStore` instance, and await every store call. `MemoryLiveStore`
remains the default and gains `close()`; the runtime calls `store.close()` on
shutdown instead of `clear()`. `LiveRuntime.store` is typed as
`LiveStateStore`. Helpers for store implementers (`isLiveStateStore`,
`liveStateUnavailable`, `liveBindingHash`, `freezeStateSnapshot`,
`freezeChildReferences`, `assertLiveComponentName`, `freezeJson`,
`isSnapshotToken`) are exported. A shared store outage while retaining a nested
child now surfaces as an error instead of silently remounting the child.
