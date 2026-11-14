---
'@nestvexa/live': minor
---

Add `@DependsOn(...tags)` and the `LiveTags` service: explicit data tags become
`tag:<tag>` realtime channels in the component's subscription token, and
`LiveTags.invalidate(tags)` (or `LiveTags.listener` as a `Cache` `onInvalidate`
hook) refreshes exactly the dependent components. No dependency detection.
