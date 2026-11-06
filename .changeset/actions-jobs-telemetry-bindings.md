---
'@nestvexa/actions': minor
---

Long-running actions: `@ServerAction({ job: true })` methods return
`acceptJob(name, handler)` and answer HTTP 202 with an owner-bound job ticket;
`<prefix>/_jobs/status` and `/_jobs/cancel` share the action admission and host
policy (group `_jobs`). The queue is a structural interface satisfied by
`@nestvexa/realtime`'s `JobRunner`, with an optional realtime channel as the
streaming handle. New `instrumentation` and `logger` host options (structurally
compatible with `@nestvexa/observability`) record one span and one redacted log
record per call with the final HTTP status. Host `authorize` now admits only a
literal `true`.

The client adds job handles (`status`, `wait` with progress, `cancel`,
`client.job(id)`), `settle()`, a framework-neutral `createActionController`
(pending/error state, optimistic updates with rollback, cancellation of
superseded calls) and `bindActionElement` for Live/HBS pages. The generator emits
`ActionMethod<Input, Output, Field>` with input field unions, per-action
`Input`/`Output`/`Error`/`Optimistic` aliases, `ActionJobHandle<T>` for job
actions, and optional `targets` (`react`, `vue`, `svelte`, `live`; CLI
`--targets`) whose declarations depend only on `@nestvexa/actions/client`.
`isActionClientError` also recognizes errors from separately bundled client
copies.
