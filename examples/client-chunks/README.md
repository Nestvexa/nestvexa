# Live client chunks

On-demand Live client feature chunks ([ADR 0036](../../docs/adr/0036-client-feature-chunks.md))
behind the canonical `boot.js`, under a nonce-only script policy
(`script-src 'nonce-…'`, no `'self'`, no `'strict-dynamic'`) and an import map
that pins every client module to its SHA-384 digest
(`{{nvScripts nonce=cspNonce integrity=true}}`).

- `/` uses ordinary directives: the browser loads only the core `index.js`.
- `/board` uses `nv:sort`: `live-sort.js` loads when the board is discovered.
  Two connected columns (`nv:sort.group`) exchange tasks by drag, touch or
  Alt+Shift+Left/Right, and a photo grid reorders by cell (Alt+Left/Right) and
  row (Alt+Up/Down). The server validates every proposal.

```sh
pnpm --filter @nestvexa/example-client-chunks build
PORT=3880 pnpm --filter @nestvexa/example-client-chunks start   # http://127.0.0.1:3880
```

`tests/browser/client-chunks.spec.ts` runs it in Chromium, Firefox and WebKit.
