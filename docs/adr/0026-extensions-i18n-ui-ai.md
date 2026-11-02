# 0026 — Optional extensions: i18n, UI kit, AI, feature flags and offline

Status: accepted for the current experimental implementation (Phase 14).

## Context

Phase 14 asks for internationalization with RTL, an accessible UI kit, offline
and progressive behavior, feature-flag-aware rendering and an AI streaming
adapter with human approval. Section 16 requires these to be real, testable,
optional packages that never pollute the default install. The core client has
a hard 48 KiB gzip budget (ADR 0020) and must not grow for optional features.
The HBS engine confines partials to the application's view root, and Live
components render through engine-level helpers only.

## Decision

1. **Five opt-in packages**, none a dependency of `nestvexa` or of any framework
   package (enforced by `scripts/boundaries.mjs`):
   `@nestvexa/i18n`, `@nestvexa/ui`, `@nestvexa/ai`, `@nestvexa/flags`,
   `@nestvexa/offline`. Browser code lives in each package's own single-file
   module (`@nestvexa/ui/browser`, `@nestvexa/ai/browser`, `@nestvexa/offline`),
   served by the host under `script-src 'self'`; it never imports Node, Nest or
   `@nestvexa/client`, so the core client size is unchanged.
2. **One small engine extension point**: `HbsEngine.registerHelpers()` adds
   trusted engine-wide helpers before initialization, and helpers now receive
   the Handlebars context as `this`. Optional packages plug into the
   umbrella-owned engine through this existing helper mechanism, without new
   umbrella options or a second template root.
3. **UI "partials" are trusted block helpers.** Shipping `.hbs` files inside
   `node_modules` would need copying or relaxing the view-root confinement. Block
   helpers render server markup with every attribute escaped, closed id grammar,
   same-origin link validation, and bodies from the application's own template
   via `options.fn(this)`. They behave the same in MVC pages and Live views.
   Interactive behavior follows the WAI-ARIA APG and uses native elements where
   they already are accessible (`<dialog>` + `showModal()`, `<details>`,
   `<progress>`).
4. **Locale is request context, not state.** `I18n.forRequest(request)`
   negotiates query → cookie → `Accept-Language` → default against an explicit
   allowlist on every request. Live components expose it through a `@Computed`
   value, so it is never stored in a snapshot, never client-writable and never an
   input to `authorize`. Pages set `Content-Language` and
   `Vary: Accept-Language, Cookie`. Text direction is derived from the locale
   and only affects markup (`dir`) and logical CSS.
5. **Flags are a separate package** because they are server-enforced capability
   checks used by guards and Live policies, not a UI concern. Evaluation fails
   closed, names are a closed allowlist, rendering uses a per-request snapshot,
   and `liveFlagPolicy` checks the flag before the host allowlist for every Live
   request including `$mount` and streams. `flagFingerprint` exists for shared
   cache keys.
6. **AI reuses the authorized text-stream transport.** No new protocol: the
   stream carries text only; tool-call status lives in server-side conversation
   state read by an ordinary authorized Live action. A tool call becomes a single
   pending approval bound to identity and conversation with a random 128-bit id,
   consumed before execution (replay and concurrent double approval execute at
   most once), re-authorized at approval time, with timeouts, cancellation and
   content-free audit events. Only a deterministic, labeled `TestProvider` ships;
   connecting a real provider is documented, not bundled.
7. **Offline is drafts plus read-only copies, never replay.** Drafts are opt-in
   per field, exclude secrets and hidden inputs, are namespaced by a server HMAC
   of the identity, expire, and are cleared on logout through an explicit API,
   `BroadcastChannel` and optional `Clear-Site-Data`. Interrupted submits keep the
   draft and change a message; reconnecting only changes the message again.
   Snapshots are stripped of scripts, handlers, Live markers and hidden inputs
   and restored `inert`.

## Rejected alternatives

- **Adding the extensions to the umbrella** — violates the opt-in rule and the
  client budget.
- **A second partial root or copying `.hbs` files** — weakens view-root
  confinement or creates drift between copies.
- **Storing the locale in Live state or URL state** — would mix presentation into
  snapshots and invite trusting a client-supplied locale.
- **A new AI wire protocol with structured envelopes** — would duplicate the
  bounded, revalidated text-stream transport; structured status is already
  available through Live state.
- **An offline action queue or automatic replay on reconnect** — section 16.2
  forbids blind replay; no idempotent allowlist exists yet.
- **A service worker** — caching authenticated HTML in Cache Storage needs a
  privacy/logout design of its own; deferred.

## Consequences and limits

- Optional browser modules are served and versioned by the host; they are not
  part of the content-addressed core asset catalog.
- ICU support is a documented subset; translation extraction is regex based.
- UI kit coverage is partial (no datepicker, uploader, drawer, wizard, popover,
  chart wrapper, table selection/filtering); the combobox needs JavaScript and the
  example adds a `<noscript>` select.
- AI conversations, approvals and flag rules are in-process; multi-instance
  deployments need shared implementations of those stores.
- Without a service worker a full page reload while offline is not supported.
- Automated axe checks run in three browsers; manual screen-reader testing is a
  documented checklist ([accessibility checklist](../testing/accessibility-checklist.md))
  that has not been executed by the implementing agent.

See the guides: [i18n](../guides/i18n.md), [UI kit](../guides/ui-kit.md),
[AI](../guides/ai.md), [offline](../guides/offline.md).
