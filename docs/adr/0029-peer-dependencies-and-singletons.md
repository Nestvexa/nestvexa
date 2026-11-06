# 0029 — Peer dependencies and runtime singletons

Status: accepted (2026-11-05). Records the rules the packages already follow
(spec 3.1, ARCH-015 and ARCH-017); no code change.

## Context

Some libraries break when two copies load in one process or one document:

- **NestJS.** DI tokens, `Reflector` and metadata keys are compared by identity.
- **`reflect-metadata` and `rxjs`.** These must be the host's single copy.
- **React, Vue and Svelte.** Hooks, reactivity and context break with two copies.
- **Official Inertia clients.** Each assumes it owns one page and one history stack.
- **Alpine.** It assumes one global instance per document.
- **`@nestvexa/client`.** It coordinates focus leases, model scheduling and component
  ownership per document.

## Decision

1. **Host frameworks are peers, never dependencies.**
   - Every server package that touches Nest declares `@nestjs/common` (and
     `@nestjs/core` where it uses it), `reflect-metadata` and `rxjs` as
     `peerDependencies` with `^12.0.0` / `^0.2.2` / `^7.8.x` ranges.
   - No package bundles them.
   - The tested matrix is Nest 12.2.0 only; see
     [upstream compatibility](../architecture/upstream-compatibility.md).
2. **Frontend frameworks are peers of the adapter that needs them.**
   - Required peers:
     - `@nestvexa/react` needs `@inertiajs/react` `^3.10.0`, `react` and `react-dom`
       `^19`.
     - `@nestvexa/vue` needs `@inertiajs/vue3` `^3.10.0` and `vue` `^3.5`.
     - `@nestvexa/svelte` needs `@inertiajs/svelte` `^3.10.0` and `svelte` `^5`.
   - Optional peers:
     - `@inertiajs/core` is an optional, types-only peer of all three.
     - `@nestvexa/islands` takes `react`, `react-dom`, `vue` and `svelte`; only the
       frameworks a page uses must be installed.
     - `@nestvexa/vite` takes `vite` `^8`.
   - Adapters never bundle a framework, so the application's bundler resolves exactly
     one copy.
3. **Optional integrations load lazily or through subpaths.**
   - `@nestvexa/forms` reaches Zod, class-validator and Live through optional peers.
     `@nestvexa/forms/live` is the only entry that imports Live.
   - `@nestvexa/realtime` loads `ws` only when the WebSocket transport is attached.
   - `@nestvexa/actions` uses `typescript` only in its codegen entry.
4. **One browser runtime per document.**
   - The `nestvexa` umbrella pins one `@nestvexa/client`, `@nestvexa/alpine` and
     `@alpinejs/csp` 3.17.5 and serves exactly those files through `nestvexa/assets`.
   - The Alpine bridge rejects binding one Alpine instance to a second client, and a
     second startup with a different runtime.
   - `nestvexa doctor` fails when more than one `@nestvexa/client` version is
     installed (`client-duplicates`).
5. **One owner per DOM root** across Live, Inertia apps and islands
   ([ADR 0004](0004-renderers-and-islands.md)), so two framework runtimes never fight
   over one subtree even when both are installed.

## Host guidance

- Keep every Nest package in the application on one version and let the package
  manager dedupe. `npm ls @nestjs/core` or `pnpm why @nestjs/core` must show a single
  version.
- With Vite, keep `react`, `vue` or `svelte` as direct dependencies of the app, not
  only transitively, so the bundle resolves one copy. Add `resolve.dedupe` only when
  a linked or monorepo setup shows duplicates.
- Do not load a second Alpine build (CDN `alpinejs` plus the umbrella's CSP build) on
  Nestvexa pages. If the host already owns Alpine startup, use `installLiveAlpine` as
  described in the [Alpine package README](../../packages/alpine/README.md).

## Consequences and gaps

- Peer ranges are wider than the tested matrix. A range is a promise to try, not
  evidence; untested combinations are listed as untested.
- **Known gap:** `doctor` checks duplicate `@nestvexa/client` copies only. It does not
  check duplicate Nest, React, Vue or Svelte installations, or peer version ranges
  (DX-030).
- **Known gap:** there is no automated bundle-duplication analysis for SPA or island
  builds (INERT-018, ISLAND-012).
