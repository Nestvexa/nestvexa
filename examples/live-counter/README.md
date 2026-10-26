# Live counter

Run `pnpm build`, then `pnpm --filter @nestvexa/example-live-counter start`. Visit `http://127.0.0.1:3101`.

This real Nest/Express server uses `express-session`, per-session CSRF tokens, exact-origin checks, server-side component state, method allowlists, and monotonic revisions. It demonstrates click actions, deferred and independently synchronized model updates, form submission, loading state, focus preservation, and an ignored local widget under a CSP without unsafe-eval.

The display name uses default deferred `nv:model` and is sent with the save action. The model section adds a live search with a100ms trailing debounce, a nickname synchronized on blur, a quantity converted to a number on change, a boolean select and a radio group. Outputs show the server-rendered value. Search has a pure writable-state validator limiting it to30 characters; rejection leaves the snapshot/revision available for a corrected update. Invalid local numeric input blocks requests until corrected. See the [model reference](../../docs/reference/directives.md) for defaults, timing/cast rules, IME behavior and unsupported inputs.

The sample explicitly permits `$sync` in `authorize` for the generated `POST /_nestvexa/live/counter/_sync` endpoint. Synchronization still checks session identity, CSRF, origin, ownership, writable state and revision. It runs component/global Nest policies without selecting an action method, so action-method guards do not protect model writes. Production must put every-write authorization in `authorize` or component/global guards. Synchronization does not call `save` or other actions and does not execute action hooks.

The sample includes the actual Alpine CSP build and an isolated local widget using `$live.call/get/set`. Its local count survives Live updates. Text/attribute/visibility/dirty/cloak/ref bindings also have browser tests. The [model scenarios](../../tests/browser/models.spec.ts) exercise the synchronization controls and error recovery; the implementation checkpoint records executed validation. The full directive matrix remains incomplete.

The session is an anonymous demonstration identity, not a login system. Production must use a persistent host session store, stable secret rotation, HTTPS secure cookies, authenticated principal/tenant binding, distributed state and policy review. Memory sessions/state do not survive restart or coordinate replicas. Do not use this sample for irreversible business operations. Advanced directives, no-JavaScript mutation fallback and the complete forms package remain unmet.
