# Default HBS, Live and Alpine setup

The alpha umbrella composes the implemented Live slice with MVC and browser startup. It requires explicit host policies and does not configure authentication or production sessions. A runnable example is [starter-live](../../examples/starter-live/src/main.ts); the [advanced counter](../../examples/live-counter/README.md) keeps its separately owned renderer and boot script.

```ts
import { NestvexaModule } from 'nestvexa';

NestvexaModule.forRoot(
  { views: { root: 'src/views', layout: 'layout' }, live: { enabled: true } },
  {
    components: [Counter],
    useFactory: () => ({ origin, resolveIdentity, authorize }),
  },
);
```

`Counter`, `origin`, `resolveIdentity` and `authorize` are application-owned values. Import decorators and `LiveRuntime` from `nestvexa`. Register components explicitly; service dependencies must be exported from the registration's `imports`. Use an ordinary Nest route to authorize the initial page, then `await live.mount(Counter, request)` and include its trusted `SafeHtml` in the view. Call `await configureNestvexa(app)` before listening. The shared HBS engine initializes once and disposes with the application. Live renders fragments with layout disabled.

The policy factory returns only `origin`, `resolveIdentity`, `authorize`, optional `store` and optional `maxRequestsPerMinute`. It may return a promise. For dependency injection, supply `imports`, `inject` and a typed `useFactory`; use `NestvexaModule.forRootAsync` independently for async core configuration. Configuration providers must be singleton-scoped; request-scoped host services belong in components or request policy callbacks. Static component types, imports and endpoint paths must be available while Nest builds its controllers, so factories cannot replace them or select a renderer.

Identity resolves authoritative session/user/tenant context and a session-bound CSRF token. Authorization must independently permit `$mount`, `$sync` when writable synchronization is intended, and each public action. An HTML marker or disabled button grants no permission. Missing registration, mismatched `live.enabled`, disabled CSRF/authorized-action flags and malformed factory output fail startup. See [Live protocol](live-protocol.md) and [hardening](../security/hardening.md) for limits and failure semantics.

## Document scripts

Put `{{nvScripts}}` once in a trusted HBS layout. The helper returns a framework-created external module tag. For nonce policies, use `{{nvScripts nonce=cspNonce}}`; the nonce must be a host-generated base64/base64url value, not browser input. No inline executable source or identity data is embedded. The host sets CSP headers.

The version-neutral `/_nestvexa/boot.js` route sends `no-store`. It imports the current content-addressed client, Alpine CSP build and adapter. It starts the pair once per document through `startLiveAlpine`. Installing the umbrella or importing its Node root does not execute a browser runtime. Existing host-owned Alpine must use `browser: { mode: 'manual' }` and the public adapter instead of starting a second runtime. In manual mode the generated boot route is absent, `nvScripts` rejects, and the asset manifest remains available.

The bootstrap preserves its original client, pending drafts and Alpine local DOM on persisted `pagehide`/BFCache restoration. Ordinary departure or explicit `dispose()` releases Live transport and page listeners. Alpine has no public stop/restart API used here; failed or disposed documents require reload. A visible host `window.Alpine` causes rejection. An undisclosed Alpine instance started earlier cannot reliably be detected through public APIs; automatic mode therefore requires delegated fresh startup.

Trusted browser extensions can register Alpine data before startup by listening for `nestvexa:alpine:init` before the boot module executes. Its `detail` exposes `{ Alpine, client }`. For application-owned error handling or other startup control, use manual mode. Keep Alpine-owned markup inside `nv:ignore` under a Live component; the current adapter exposes `$live.call/get/set`, not the full planned entanglement API.

## Prefixes and versions

`endpoint` defaults to `/_nestvexa/live`. `basePath` describes the public host prefix in generated Live URLs; it does not set Nest routing. `browser.path` defaults to `/_nestvexa`, `browser.assetsPath` to `/_nestvexa/assets`, and `browser.basePath` to the Live `basePath` or empty string. A boot prefix exactly one segment below the asset prefix rejects at registration because its boot.js URL would also match the asset route. Register one browser owner and avoid other host route collisions.

With `app.setGlobalPrefix('host')`, use `basePath: '/host'`. Header versioning leaves those public paths unchanged, but the automatic boot does not invent host-specific API negotiation headers. When the host requires custom header/media-type negotiation, use manual browser startup with a host-controlled transport. With URI default version `1`, Live routes follow normal Nest versioning: use `basePath: '/host/v1'` and `browser: { basePath: '/host' }`, because browser boot/assets are version-neutral. Reverse-proxy public prefixes follow the same explicit rule. Heterogeneous frontend roots and Vite are outside this slice.

## Verification and limitations

Run `pnpm build`, `pnpm --filter @nestvexa/example-starter-live start`, `pnpm exec vitest run tests/umbrella-live.test.ts tests/live-async.test.ts tests/alpine-start.test.ts`, `pnpm test:e2e` and `pnpm test:pack`. Tests exercise real Nest applications, actual Alpine CSP and external npm/pnpm installations; executed results live in the implementation checkpoint reports. Browser lifecycle tests dispatch persisted events deliberately and do not claim every browser navigation enters BFCache.

This reduces default setup boilerplate, but it does not implement the CLI initializer, full Live directives, forms, uploads, distributed state, Inertia or framework islands. Production authentication, persistent stores, identity revocation, operation timeouts and independent security review remain application/release work.
