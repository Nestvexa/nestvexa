---
'@nestvexa/client': minor
'@nestvexa/live': minor
'@nestvexa/alpine': minor
'nestvexa': minor
---

`nv:model` and the state bindings accept dotted paths (`address.city`); the client
sends a nested draft as its whole top-level field and the server accepts it only
through the new `@State({ writable: ['city', 'geo.lat'] })` nested allowlist
(other differences, added or removed keys are `422 STATE_LOCKED`, leaf kind
changes `STATE_TYPE`; `describeLiveState()` reports `writablePaths`). Checkboxes
modelling array state form value groups; file inputs point at `nv:upload`.
Browser-restored values become drafts announced by `nestvexa:restored`.

Server-declared idempotent actions (`data-nv-idempotent`) are resent with the
same `requestId` after drops, timeouts and 409/429/502/503/504 (two resends,
full jitter); nothing else is retried. A queued `$sync` folds into a request
that has not started. Live action and `$sync` replies advertise
`x-nestvexa-protocol` and `x-nestvexa-capabilities`; another major or a 426 is
reported as `PROTOCOL`. Components dispatch `nestvexa:request` progress events,
and `createLiveClient({ development: true })` enables a sanitized `inspect()`.

`adoptLiveAlpine` and `hostAlpine` let the default boot module bind Live to a
host-owned Alpine without starting it.
