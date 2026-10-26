# Host hardening

Treat this alpha as an implementation preview. Run behind TLS, set proxy trust explicitly for your deployment, and configure secure headers and a restrictive CSP. Keep templates outside any user-upload directory and deploy them read-only. Never compile a template body supplied by a user.

Use plain DTO view models. `{{value}}` escapes HTML text; `{{{value}}}` does not. Escaping does not validate URL schemes or make arbitrary CSS safe. Helpers are trusted executable code. Use host-owned authorization to select data for each request; never store request-specific state in shared configuration or cached HTML.

Normal Nest guards, pipes and interceptors remain application responsibilities. The MVC convenience module registers no mutation routes or session middleware. Explicit `LiveModule.register` adds POST action routes with exact-origin and session-token CSRF checks, an authorization callback, state ownership binding, limits and revision locking. Hosts supply authoritative identity and CSRF tokens and configure body-parser limits before parsing. Security booleans alone do not replace this configuration. See the [Live protocol](../guides/live-protocol.md).

Bind Live state to session, principal and tenant, and revoke that binding on logout or permission revocation. Private pages carrying mount tokens must use `Cache-Control: no-store`. In-memory stores require a single process and are lost at restart. Use host business idempotency and database transactions for irreversible effects; Live revision rejection is not an exactly-once transaction guarantee.

The lockfile overrides Multer to2.5.0 for GHSA-q7qp-rjg7-q26m. Nest12.2.0's Express platform pins2.4.0, so downstream apps must apply the patched resolution too until upstream updates. Repository overrides do not automatically transfer into a consumer app.

No raw cookies, tokens or private DTOs should be logged. The current packages do not include telemetry. Do not expose development errors publicly. Report security issues privately through an owner-provided channel once configured; see [policy](../../SECURITY.md).
