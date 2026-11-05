# Documentation site

The Nestvexa documentation website is built from the Markdown already in the
repository: `docs/`, the root community files, and every package and example README.
This directory holds only the builder, its navigation and its static assets. The
design is recorded in [ADR 0027](../../docs/adr/0027-documentation-site.md).

## Build

```sh
pnpm build        # the API reference and CLI check read built packages
pnpm docs:build   # checks, then writes the site to artifacts/docs
```

Open `artifacts/docs/index.html` in a browser; the site is static, has no external
requests and works from the file system. `node apps/docs/src/build.mjs --check-only`
runs the checks without writing output; `--out <dir>` changes the output directory.

## What the build checks

The build fails, listing every problem, when:

| Check              | Rule                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure          | A page starts with one `# ` title, has exactly one H1 and never skips a heading level (evidence records under `docs/implementation/`, `CHANGELOG.md` and `THIRD_PARTY_NOTICES.md` are exempt) |
| Links              | Relative links resolve to an existing file; no absolute `/` links                                                                                                                             |
| Anchors            | `file.md#anchor` and `#anchor` match a GitHub-style heading slug or an explicit `id`/`name`                                                                                                   |
| Snippet provenance | A fence after `<!-- snippet: path -->` is a whitespace-insensitive excerpt of that file                                                                                                       |
| CLI                | Every `` `nestvexa <command>` `` in the CLI reference and every `npx nestvexa <command>` anywhere appears in `nestvexa --help`                                                                |
| Dependency graph   | [package-dependency-graph.md](../../docs/architecture/package-dependency-graph.md) has every package and exactly the workspace edges in the manifests                                         |
| Coverage           | The [feature matrix](../../docs/feature-matrix.md) and [architecture overview](../../docs/architecture/overview.md) mention every package                                                     |
| API entry points   | Every typed `exports` subpath has its built `.d.ts`                                                                                                                                           |
| Navigation         | Every page listed in `nav.json` exists                                                                                                                                                        |

External `http(s)` links are not fetched.

## Writing pages

- Write normal GitHub-flavoured Markdown. Link to other pages with relative `.md`
  paths; the site rewrites them to `.html`, and links to source files go to GitHub.
- Quote real code where you can. Put `<!-- snippet: examples/<path> -->` on the line
  above the fence, optionally followed by one blank line (Prettier inserts it). Prettier
  reformats complete TypeScript or HBS inside fences, so the comparison ignores all
  whitespace; quote whole statements or a fragment Prettier cannot parse.
- Mark unfinished behaviour with a blockquote starting `> **Known gap:**`. Do not
  describe a feature as working without a test that proves it.

## Navigation

[`nav.json`](nav.json) lists sections in order. A section has optional `pages`
(explicit order), `links` (generated pages such as the API reference) and `include`
(a glob such as `docs/guides/*.md`, sorted by title). A new page that matches an
`include` glob needs no configuration; a page that matches nothing still appears
under **More**.

## API reference

`src/api-reference.mjs` loads every package's typed `exports` entry points into one
TypeScript program and lists each export: its kind, declaration text, TSDoc summary,
`@deprecated` tag and the package it is re-exported from. The output is
`api/<package>.html` plus a machine-readable `api/api.json`. To improve an entry, add
or fix the TSDoc comment in the package source and rebuild.

## Files

| Path                    | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `src/build.mjs`         | Entry point: load, check, render, write           |
| `src/markdown.mjs`      | `marked` lexer/renderer wrappers, GitHub slugs    |
| `src/layout.mjs`        | Page shell, sidebar, table of contents            |
| `src/api-reference.mjs` | Declaration-file API extraction                   |
| `assets/`               | Stylesheet and the optional sidebar filter script |
| `nav.json`              | Site title, repository URL and navigation         |
