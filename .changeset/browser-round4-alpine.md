---
'@nestvexa/alpine': minor
---

Add `$live.state` (a read-only reactive view of public state) and
`$live.entangle(name)` (two-way binding of a primitive field to Alpine data
that stages drafts like `$live.set`). The default bootstraps destroy Alpine
trees before an `nv:navigate` body swap so first-render `$live.on`
subscriptions are released.
