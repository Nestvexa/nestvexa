# Default Live starter

`/init` demonstrates eager [`nv:init`](../../docs/reference/nv-init.md), request
loading and retained Alpine local state. `/init/denied` demonstrates server denial
without automatic retry. The initial HTML remains available without JavaScript;
this is not a lazy-hydration or progressive-action example. See the
[real-server browser cases](../../tests/browser/initialization.spec.ts).

The work-board removal button demonstrates [`nv:confirm`](../../docs/reference/nv-confirm.md)
with a native prompt, keyboard cancellation/approval and a real session-bound Nest
action. Empty lists can add new items again. This changes public seed data only;
a UI prompt is not authorization or proof of consent. See [browser cases](../../tests/browser/confirmation.spec.ts)
for direct-request, cross-session and CSRF coverage.

Open `/board` for a real HBS/decorator work table with live search, keyed sorting,
server-validated keyboard submission, pending/dirty/error states and an ignored
Alpine notes widget. Its seeded public data is session-bound and limited to 50
items; it is not a persistent CRUD/auth starter. [Browser scenarios](../../tests/browser/phase3-board.spec.ts)
exercise real endpoints, negative state writes, accessibility and a rendered
visual round trip. `/board/ownership` supplies two independent server-mounted
roots for the explicit nested DOM ownership fixture; it is not the Phase 4
parent/child lifecycle API.

The first [Phase 4 hook example](../../docs/guides/live-update-hooks.md) displays
the last accepted client field via `afterUpdate`, on both model synchronization
and submission. This does not make the remaining lifecycle or Phase 4 complete.

Build from the repository root with `pnpm install --frozen-lockfile && pnpm build`, then run `pnpm --filter @nestvexa/example-starter-live start` and open <http://127.0.0.1:3102>.

This example imports the server API from `nestvexa`, registers a counter and explicit host policies, shares HBS between MVC and Live, and uses `{{nvScripts}}` for automatic client/Alpine CSP startup. It has no frontend build tool or direct Live/client/Alpine package dependency. Native `/api/health` and `/about` remain ordinary Nest routes. The ignored Alpine widget preserves local state while the counter updates.

The session is a local guest demonstration with a random process secret and in-memory store. Production must supply authentication, a stable secret, persistent sessions, HTTPS cookies, authoritative user/tenant bindings, revocation and resource permissions. CSRF and origin checks remain required. Ordinary navigation works without JavaScript; the counter does not have a progressive HTML action fallback yet.

The focus target input and server disable/hide actions demonstrate [post-update keyboard focus restoration](../../docs/guides/focus-restoration.md). Its unbound draft remains browser-local while the server changes availability.

The local editable row and reorder action demonstrate retained caret/forward/backward ranges through keyed moves. Edit its text and press **Ctrl+Enter** to reorder the row through a real server action while keeping editor focus. [Browser tests](../../tests/browser/editor-selection.spec.ts) exercise the keyboard action, newer selection during transport, outside focus and scroll. Clicking the button normally moves focus according to the browser; the client does not force it back to an unfocused editor. Editor HTML is not model state or submitted by the reorder action.

See the [setup guide](../../docs/guides/default-live-setup.md). Browser tests are in [default-setup.spec.ts](../../tests/browser/default-setup.spec.ts). Run `pnpm test:e2e` after building; reports distinguish executed results from remaining acceptance requirements.

The Interests form demonstrates [multiple-select model arrays](../../docs/guides/multiple-select.md), server allowlist validation, mirrored aliases, change synchronization, reset and newer edits during a slow save. Its browser tests call real Nest endpoints and verify malformed arrays and independent session ownership. The form requires JavaScript for Live actions and has no HTML submission fallback yet.
