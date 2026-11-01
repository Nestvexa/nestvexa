---
'@nestvexa/client': minor
'@nestvexa/live': minor
'@nestvexa/alpine': minor
'nestvexa': minor
---

Add server-mounted nested Live components. Parents declare an explicit child
allowlist and mount keyed children with the trusted `nvChild` template helper.
`@Prop`, `@Reactive` and `@Modelable` define parent-owned values; unchanged
children are retained as stubs, changed reactive values refresh only that child,
and removed children are revoked. Add browser-routed events (`dispatchLiveEvent`,
`@OnEvent`, `client.dispatch`, Alpine `$live.dispatch`), lazy components with
placeholders, and application-relative `redirectLive`. The custom client size
budget is revised to 48 KiB gzip (ADR 0020).
