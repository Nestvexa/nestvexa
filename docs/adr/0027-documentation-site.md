# 0027 — Documentation site built from repository Markdown

Status: accepted (2026-11-05).

## Context

Spec sections 3 and 22 require a maintained documentation website under `apps/docs`
that builds in CI, checks internal links, verifies snippets and includes an API
reference for every package. Before this decision `scripts/docs.mjs` only checked that
link targets existed and wrapped each Markdown file in a `<pre>` block.

The docs are written by many engineers in parallel, in plain Markdown that must also
read correctly on GitHub. The site must work offline in CI (no network fetches), under
a strict CSP, and must not depend on production keys or unpublished packages.

## Decision

- **Source stays in Markdown in the repository** (`docs/`, root community files,
  package and example READMEs). Nothing is duplicated into `apps/docs`.
- **`apps/docs` holds the site builder** (`src/build.mjs`, `src/markdown.mjs`,
  `src/layout.mjs`, `src/api-reference.mjs`), navigation (`nav.json`) and static
  assets. It is not a workspace package; `pnpm docs:build` runs it through
  `scripts/docs.mjs`, and output goes to `artifacts/docs` (uploaded as CI evidence).
- **Markdown is rendered by `marked` 18.1.3**, pinned exactly as a root dev
  dependency. It has no dependencies of its own and is MIT licensed.
- **The API reference is generated with the TypeScript compiler API** (the pinned
  `typescript` 6.0.3 already in the workspace) from each package's published `.d.ts`
  entry points: every `exports` subpath with types, each exported symbol with its
  declaration text and TSDoc summary. It also writes `api/api.json`.
- **The build is also the docs test.** It fails on: missing or duplicate H1, skipped
  heading levels, broken relative links, missing heading anchors, absolute links,
  snippet drift, documented CLI commands that `nestvexa --help` does not list,
  dependency-graph drift from `package.json` files, and packages missing from the
  feature matrix or architecture overview.
- **Snippet provenance.** A fence preceded by `<!-- snippet: <path> -->` must be a
  whitespace-insensitive excerpt of that file. Pointing snippets at example or test
  sources ties documentation to code that CI compiles and runs.

## Alternatives rejected

- **TypeDoc 0.28.20** (supports TypeScript 6.0). It adds `markdown-it`, `minimatch`
  10, `yaml`, `lunr` and a Shiki build to the install. The `minimatch` 10 line is the
  subject of the advisory handled in [ADR 0016](0016-tooling-glob-security-override.md),
  so it would need another override for `pnpm audit --audit-level high` to stay green.
  Its HTML theme would also be a second site with its own navigation.
- **VitePress, Docusaurus, Astro Starlight.** Each brings a large dependency tree,
  often a second frontend framework, and its own Markdown dialect, for features we do
  not need yet (versioned docs, i18n routing, client search). Offline CI builds and the
  strict CSP would need extra configuration.
- **A hand-written Markdown parser.** Smaller, but a parser is a maintenance burden
  and GFM tables, lists and nested fences are easy to get subtly wrong.
- **Committing generated API Markdown.** It would go stale between builds and cause
  merge conflicts between parallel branches. The reference is generated at build time.

## Consequences

- `pnpm docs:build` needs built packages (`pnpm build`) for the API reference and the
  CLI check; in CI it runs after `pnpm typecheck`, which builds. A clear error tells
  you to build first.
- Mermaid blocks are shown as source, not rendered: rendering would need a browser or
  a large dependency. GitHub renders them.
- External links are not fetched; dead external URLs are not detected.
- Only provenance-marked snippets are verified. Other snippets are reviewed by hand
  against the real exports.
- No screenshots or visual regression tests of the site yet (DOC-041).
- Adding a page needs no configuration: any Markdown file matching a section's
  `include` glob in `nav.json` is listed automatically, and anything unmatched appears
  under "More".

## Evidence

`pnpm docs:build` output and the `artifacts/docs` directory;
[site README](../../apps/docs/README.md).
