# 0024 — Frontend adapters, Vite integration and SSR

Status: accepted for the experimental alpha (Phases 9–11).

## Context

`@nestvexa/inertia` (ADR 0018) speaks the Inertia v3 protocol and defines an SSR
renderer contract, but applications still need: Vite builds wired into Nest
documents (manifest tags, CSP, static files, dev mode), official React, Vue and
Svelte client setup with safe page resolution, server rendering that plugs into
the contract, and proof that several frameworks can share one Nest backend.

## Decision

1. **`@nestvexa/vite`** is framework-neutral and Node-only (plus a browser-safe
   `./pages` entry). Production reads each app's `.vite/manifest.json` once at
   startup, renders nonce-bound tags and serves the build directory from an
   in-memory index (no request path is ever joined to the filesystem). Vite is
   an optional peer imported lazily only by `createViteDevServer` (middleware
   mode, HMR on the Nest HTTP server). Asset versions are manifest hashes.
2. **One adapter per framework** (`@nestvexa/react`, `@nestvexa/vue`,
   `@nestvexa/svelte`) with the framework and the official `@inertiajs/*`
   client as **peer dependencies**. Each provides a resolver over an explicit
   `import.meta.glob` registry, a client entry that hydrates when the root has
   `data-server-rendered` (React `hydrateRoot`, Vue `createSSRApp`, Svelte 5
   `hydrate`) and mounts otherwise, error boundaries where the framework has an
   API, and an SSR render function built on the official `createInertiaApp`
   server path, so markup and page JSON escaping come from upstream
   `buildSSRBody`.
3. **Two SSR transports, both on the existing contract.** `moduleSsrRenderer`
   imports the built SSR bundle into the Nest process; `startOfficialSsrServer`
   runs the official Inertia SSR HTTP server (loopback by default) for
   `HttpSsrGateway`. The React example uses the process, Vue/Svelte/mixed use
   in-process rendering. Failures are classified and the adapter's
   `fallback`/`strict` mode decides; error boundaries never swallow SSR errors.
4. **Public declarations avoid upstream types.** `@inertiajs/*` 3.10.0
   declarations need `moduleResolution: "bundler"` (extensionless relative
   imports) and `@inertiajs/svelte` has a TS2440 declaration error. Adapters are
   compiled with bundler resolution but expose self-contained types
   (`InertiaPageLike`, `SsrRender`, …) so NodeNext consumers can import them.
5. **Svelte receives `createInertiaApp` by injection** because
   `@inertiajs/svelte` publishes only the `svelte` export condition.
6. **Multiple roots** are separate Vite builds (own `base`, manifest, version,
   SSR bundle) on separate path prefixes. Cross-root Inertia visits get a 409
   from namespaced versions and become full page loads; there is no
   cross-framework SPA bridge.

## Alternatives considered

- A single Vite build with all frameworks: rejected — duplicate runtimes risk,
  implicit mixed hydration, one version for unrelated apps.
- Resolving component names to module paths (`import(`./pages/${name}`)`):
  rejected — a server bug or tampered page object could load any module.
- `@inertiajs/vite` plugin's `pages` option: usable, but the explicit registry
  keeps the allowlist visible and testable and works the same in all three
  frameworks.
- Always running a separate SSR process: more isolation, but an extra port and
  process for every app; offered as an option instead of the only path.
- Re-exporting upstream types: breaks NodeNext type-checking for consumers.

## Consequences

- Production hosts need no Vite install; dev mode needs `vite` and the plugin.
- In-process SSR shares the event loop; timeouts bound responses, not renders.
- Svelte production builds do not report hydration mismatches; tests assert DOM
  node adoption instead (negative control verified).
- Upload, optimistic UI and universal actions are demonstrated only partially
  (uploads in React); see the phase notes.

## Verification

`tests/vite-*.test.ts`, `tests/{react,vue,svelte}-adapter.test.ts`, and
Playwright `tests/browser/inertia-{react,vue,svelte,mixed}.spec.ts` in Chromium,
Firefox and WebKit against production Vite builds with SSR.
