# Third-party browser code notices

Nestvexa's own source uses the [project MIT license](LICENSE). Third-party packages retain their original licenses and notices. This record describes browser code exposed by the current explicit client asset module; it is not a complete dependency SBOM, license audit or legal clearance for a release.

| Served browser code                           | Origin and license information                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpine.js`                                   | The installed `@alpinejs/csp` 3.17.5 `dist/module.esm.js`, from [Alpine.js](https://github.com/alpinejs/alpine/tree/main/packages/csp). Its package metadata declares MIT. Alpine's upstream license is [available here](https://github.com/alpinejs/alpine/blob/main/LICENSE.md). |
| Code bundled inside `alpine.js`               | The installed CSP build includes MIT notices identifying `@vue/shared` and `@vue/reactivity` 3.5.41, copyright 2018–present Yuxi (Evan) You and Vue contributors. The [Vue core license](https://github.com/vuejs/core/blob/main/LICENSE) remains authoritative for that code.     |
| Nestvexa Live modules and `alpine-adapter.js` | Nestvexa project source under the project MIT license.                                                                                                                                                                                                                             |

The asset service reads the original installed ESM content and serves the same snapshotted strings. It does not strip the upstream bundled license comments or rewrite third-party source. Keep those comments and applicable original license/copyright notices when copying, bundling, minifying or redistributing the code. Review the exact dependency distributions and lockfile used for a release; future upstream versions can change bundled components and notice text.

The MIT permission and warranty text below applies separately to the Alpine and Vue portions identified above, with their respective upstream copyright notices, rechecked October 27, 2026:

```text
Alpine.js: Copyright © 2019-2025 Caleb Porzio and contributors
Vue: Copyright (c) 2018-present, Yuxi (Evan) You and Vue contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Rechecked **2026-11-14** after rounds 2–4: the served browser code is unchanged. The asset host still serves exactly the Nestvexa client bundle (`index.js`), the Alpine adapter and `@alpinejs/csp` 3.17.5, whose bundled `@vue/shared` and `@vue/reactivity` notices still read 3.5.41. Browser code added in rounds 2–4 (realtime, islands, offline queue, devtools inspector, Inertia adapters, UI kit wrappers) is Nestvexa source under the project MIT license. Framework runtimes such as React, Vue, Svelte and the official Inertia clients are installed and bundled by the application under their own licenses; the Nestvexa asset host does not serve them.

The default package also uses server and tooling dependencies whose terms remain in their original distributions. Published packages declare runtime dependencies only on `handlebars` (MIT), `ejs` (Apache-2.0), `pug` (MIT), `nunjucks` (BSD-2-Clause), `busboy` (MIT), `typescript` (Apache-2.0, CLI) and `@alpinejs/csp` (MIT). `pnpm test:pack` writes a CycloneDX SBOM per package to `artifacts/sbom/`, and `pnpm audit:licenses` checks every production dependency and declared peer against an SPDX allowlist ([ADR 0007](../../docs/adr/0007-packaging-and-release.md)). These are engineering checks, not legal clearance. Mention of Alpine.js, Vue, NestJS, Livewire or Inertia does not imply project affiliation or trademark ownership.
