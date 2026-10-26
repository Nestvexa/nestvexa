# Live counter

Run `pnpm build`, then `pnpm --filter @nestvexa/example-live-counter start`. Visit `http://127.0.0.1:3101`.

This real Nest/Express server uses `express-session`, per-session CSRF tokens, exact-origin checks, server-side component state, method allowlists, and monotonic revisions. It demonstrates click actions, model updates submitted with actions, form submission, loading state, focus preservation, and an ignored local widget under a CSP without unsafe-eval.

The sample includes the actual Alpine CSP build and an isolated local widget using `$live.call/get/set`. Its local count survives Live updates. Text/attribute/visibility/dirty/cloak/ref bindings also have browser tests. The full directive matrix remains incomplete.

The session is an anonymous demonstration identity, not a login system. Production must use a persistent host session store, stable secret rotation, HTTPS secure cookies, authenticated principal/tenant binding, distributed state and policy review. Memory sessions/state do not survive restart or coordinate replicas. Do not use this sample for irreversible business operations. Advanced directives, no-JavaScript mutation fallback and the complete forms package remain unmet.
