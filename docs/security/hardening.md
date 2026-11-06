# Host hardening

Treat this alpha as an implementation preview. Run behind TLS, set proxy trust explicitly for your deployment, and configure secure headers and a restrictive CSP. Keep templates outside any user-upload directory and deploy them read-only. Never compile a template body supplied by a user.

Use plain DTO view models. `{{value}}` escapes HTML text; `{{{value}}}` does not. Escaping does not validate URL schemes or make arbitrary CSS safe. Helpers are trusted executable code. Use host-owned authorization to select data for each request; never store request-specific state in shared configuration or cached HTML.

Normal Nest guards, pipes and interceptors remain application responsibilities. The MVC convenience module registers no mutation routes or session middleware. Explicit `LiveModule.register` adds POST action routes with exact-origin and session-token CSRF checks, an authorization callback, state ownership binding, limits and revision locking. Hosts supply authoritative identity and CSRF tokens and configure body-parser limits before parsing. Security booleans alone do not replace this configuration. See the [Live protocol](../guides/live-protocol.md).

Bind Live state to session, principal and tenant, and revoke that binding on logout or permission revocation. Private pages carrying mount tokens must use `Cache-Control: no-store`. In-memory stores require a single process and are lost at restart. Use host business idempotency and database transactions for irreversible effects; Live revision rejection is not an exactly-once transaction guarantee.

Model modifiers use the separate `_sync` route and require explicit `$sync` authorization. Protect component read access and hydrate/dehydrate/render hooks with global/class guards and the host callback: action-method guards do not execute during synchronization. Apply writable-state validators for domain limits even when HTML input constraints exist. Validators run before the transaction, receive immutable detached JSON, and must be pure and bounded; validation failures leave the snapshot usable. Synchronization can run lifecycle hooks, so do not retry it blindly after an unknown network result.

The lockfile overrides Multer to2.5.0 for GHSA-q7qp-rjg7-q26m. Nest12.2.0's Express platform pins2.4.0, so downstream apps must apply the patched resolution too until upstream updates. Repository overrides do not automatically transfer into a consumer app.

No raw cookies, tokens or private DTOs should be logged. The current packages do not include telemetry. Do not expose development errors publicly. Report security issues privately through an owner-provided channel once configured; see [policy](../../SECURITY.md).

## Optional subsystems (2026-11-01)

- **Realtime.** Load `RealtimeModule` secrets from the environment (≥32 bytes, rotate by
  prepending a new secret). Authorize channels from authoritative identity and tenant,
  call `revoke(binding)` on logout and `closeChannel()` after permission changes, keep
  SSE query tokens out of shared access logs, and enable the WebSocket transport only
  with `resolveUpgradeIdentity` and the exact public `origin`.
- **Uploads.** Store files outside the web root, keep the default type allowlist narrow,
  configure a real malware scanner (`requireScan`) where your threat model needs one,
  and serve stored files only through the safe download helper (attachment, `nosniff`,
  sandbox CSP). Pending tokens are per process: use sticky sessions with several nodes.
- **Forms.** Keep `whitelist`/`forbidNonWhitelisted` enabled for class-validator, use the
  hardened urlencoded parser (`extended: false`) and single-use submission tokens for
  non-idempotent no-JS posts.
- **Downloads and redirects.** `downloadLive` and `redirectLive` already restrict
  content and targets; never pass user-chosen absolute URLs to your own redirects.
- **Navigation.** `nv:navigate` falls back to full loads when assets differ; still send
  `Cache-Control: no-store` on private pages so history revisits re-authorize.
- **Cache.** Never cache Live snapshots, CSRF tokens or per-user HTML without a private
  scope and complete `vary` inputs.
- **Telemetry.** Use the redacting logger and the provided span attributes; never
  register `DevtoolsModule` in production (it refuses) or without host authorization.
- **CommonJS hosts.** Packages are ESM loaded through `require(esm)` on Node 22.12+;
  older Node versions are unsupported.
- **CLI.** Review `nestvexa init` changes (use `--dry-run`) and replace the generated
  guest identity policy before deployment.
- **Windows hosts and request-derived paths (2026-11).** Node 22/24 on Windows abort
  the whole process (libuv assertion) for any filesystem path containing U+10FFFF.
  Nestvexa view names and includes refuse it; if your own code builds paths from
  request values, reject control characters, unpaired surrogates and Unicode
  noncharacters (`/[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/u`) first. Never pass
  request data to EJS `include()` without an allowlist.
- **Realtime replay memory.** `MemoryRealtimeBroker` keeps replay history for at most
  `replayChannels` channels (default 10,000); size it to your channel cardinality.
