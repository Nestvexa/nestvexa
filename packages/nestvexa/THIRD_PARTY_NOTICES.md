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

The default package also uses server and tooling dependencies whose terms remain in their original distributions. An exhaustive release inventory, third-party license review and SBOM remain release work recorded in the implementation tracker. Mention of Alpine.js, Vue, NestJS, Livewire or Inertia does not imply project affiliation or trademark ownership.
