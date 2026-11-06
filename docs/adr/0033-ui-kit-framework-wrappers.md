# 0033 — UI kit framework wrappers on one markup contract

Status: accepted (2026-11-06). Extends [ADR 0026](0026-extensions-i18n-ui-ai.md)
(optional UI kit) and follows [ADR 0029](0029-peer-dependencies-and-singletons.md)
(peers and singletons). Ledger rows EXT-016, EXT-017 and EXT-020.

## Context

`@nestvexa/ui` shipped HBS/Live helpers and a framework-neutral keyboard module
(`@nestvexa/ui/browser`). React, Vue and Svelte pages (Inertia roots, islands) had
no way to use the same primitives except copying markup by hand, which drifts from
the ARIA/data attribute contract the keyboard module depends on. Three questions:

1. Where the wrappers live (subpath entries of `@nestvexa/ui` or new packages).
2. How the wrappers stay identical to the HBS markup.
3. How Svelte components ship, since Svelte components are compiled source.

## Decision

1. **One markup contract.** `@nestvexa/ui/markup` builds a validated element tree
   (`{ tag, attributes, children }` with named slots) for the dialog/drawer, dialog
   trigger, tabs, menu button, toast region, date picker and data table pieces
   (table, search, filter, select-all, select-row, sort header). The HBS helpers
   print these trees with `renderMarkup` (output byte-identical to the previous
   helpers); the wrappers render the same trees with their own element factories.
   The module has no Node, DOM or `@nestvexa/views` import.
2. **Subpath entry points, not packages.** `@nestvexa/ui/react`, `@nestvexa/ui/vue`
   and `@nestvexa/ui/svelte` ship in `@nestvexa/ui`. React (`^19`), Vue (`^3.5`) and
   Svelte (`^5`) are **optional** peers (`peerDependenciesMeta`), so HBS-only hosts
   install nothing new and the package has no new runtime dependency.
3. **Behavior is shared, not reimplemented.** Wrappers call `connectUi(element)` from
   `@nestvexa/ui/browser` on mount and release it on unmount. Connections share one
   document-level controller (reusing an application's own `initUi()` controller),
   so light dismissal and dialog triggers work across components, and nested scopes
   never handle one event twice. Wrappers import the browser module by its package
   specifier so the bundler loads a single copy (its focus and open-dialog state is
   per document).
4. **Uncontrolled components.** The keyboard module owns open, selected and
   formatted state in the DOM. Initial values (`defaultValue`, `defaultChecked`,
   toast `messages`) are read once; callbacks/events report changes (`onSelect`,
   `onChange`, `onClose`, Vue `select`/`change`/`close`, Svelte `onselect`/
   `onchange`/`onclose`) and toasts are shown through a handle (`ref`, Vue
   `expose`, Svelte instance export).
5. **Svelte ships as `.svelte` source** under the `svelte` export condition, the
   convention of Svelte libraries: the application's Svelte compiler (Vite plugin)
   compiles the components with its own Svelte version, which avoids shipping code
   compiled against a different runtime. Types are a hand-written `index.d.ts` of
   `Component<Props>` declarations. React and Vue wrappers are TypeScript compiled
   with `createElement` / `h()` (no JSX or SFC build step).
6. Live-only options (`model`, `action`) stay HBS features; the wrappers' prop types
   do not expose them and the renderers drop `nv:*` attributes.
7. `scripts/boundaries.mjs` keeps the server entry and the markup contract free of
   React, Vue and Svelte imports.

## Rejected alternatives

- **Separate `@nestvexa/ui-react|vue|svelte` packages.** Three more versions to keep in
  lock step with the contract and the browser module; the contract would become a
  cross-package API. Subpaths keep one version and one changelog.
- **Reimplementing the primitives with framework state** (Radix-style). Duplicates the
  keyboard behavior per framework and loses parity with HBS/Live pages.
- **`dangerouslySetInnerHTML`/`{@html}` of the HBS output.** Cannot host framework
  children (dialog bodies, tab panels, table rows) and bypasses framework escaping.
- **Precompiled Svelte output.** Ties the package to one Svelte runtime version.

## Consequences and failure modes

- A framework re-render with **changed** props rewrites the attributes it owns, which
  can reset module state (for example a changed `tabs` list reselects from props).
  Unchanged re-renders touch nothing. Use a `key` to remount deliberately.
- The first `connectUi` of a document scans the whole document, so primitives in
  subtrees that are not hydrated yet are set up early; hydrate before mounting other
  wrappers when using partial hydration.
- If an application calls `initUi()` after wrappers created the shared controller, it
  receives that controller, which is disposed when the last wrapper unmounts.
- Not wrapped yet: accordion, popover, tooltip, breadcrumbs, badge, alert, file
  upload, wizard, combobox, pagination and progress (HBS helpers only). Svelte
  components are checked by compiling them in tests, not by `svelte-check`.

## Evidence

- `tests/ui-adapters.test.ts`: SSR output of the React, Vue and Svelte fixtures is
  canonically equal to the HBS helpers' output; hydration under a strict CSP without
  mismatch; keyboard behavior (dialog trap/Escape/focus return, tabs, menu, toasts,
  date picker, data table filtering and selection), framework callbacks, axe and
  unmount/remount in Chromium, Firefox and WebKit (`NV_UI_BROWSERS`).
- `tests/ui-primitives.test.ts`, `tests/ui-helpers.test.ts`,
  `tests/ui-primitives-browser.test.ts`: unchanged HBS behavior.
