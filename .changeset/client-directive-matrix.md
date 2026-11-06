---
'@nestvexa/client': minor
'@nestvexa/alpine': minor
---

Add `nv:loading[.class|.attr][.remove].delay[.Nms]` activation delays (default
200ms, 1–10000ms) so quick work never flashes an indicator, and `.window` /
`.document` scopes for `nv:click` and `nv:keydown` that listen globally only
while the declaring element stays owned and accept trusted events only. Server
fragments and `nv:navigate` documents now pass through a module-private
`nestvexa` Trusted Types policy, so pages enforcing
`require-trusted-types-for 'script'` can allow the client explicitly; a page
policy excluding it fails closed. A suspended component keeps its presentation
registrations, so `nv:offline` no longer reverts to markup that announced an
outage after a 500 or protocol error. The Alpine adapter adds
`$live.on(name, callback)` with per-subscriber payload copies, an unsubscribe
function, a 32-subscription bound and automatic Alpine cleanup; `$live.state`
and `$live.entangle` are documented as intentionally not provided.
