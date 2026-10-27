---
'@nestvexa/client': patch
---

Reconcile native form resets with owned primitive model drafts and binding state. Cancel affected model timers, preserve later reset field versions across pending responses, and leave canceled resets unchanged. Reset is local and never automatically calls an action or synchronization endpoint.

Predict native defaults without reading unrelated controls. Reject unrepresentable defaults, conflicting field aliases and cross-owner radio reset groups. Ignore synthetic reset events and clean up pending plans and the single deferred task on disposal. A deferred task handles native button dispatch microtask timing; synchronous state access also flushes completed resets.
