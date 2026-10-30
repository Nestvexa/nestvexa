---
'@nestvexa/live': minor
'nestvexa': minor
---

Add explicit async computed methods and request/stage-local memoization with
state dependency keys, bounded TTL/deadlines and detached JSON results.
Managed getters now cache by default; opt out with cache:false when evaluation
must occur on every read. Overrides must repeat @Computed explicitly. No wire or
browser asset change.

Reject ineffective Nest route/parameter/policy decorators on computed methods;
their metadata is not a route execution pipeline. Authorize reads in host routes
and services instead.
