# Server actions example

A small Nest + HBS shop page whose browser script calls a **generated, typed**
`@nestvexa/actions` client: `actions.cart.addItem({ productId, quantity })`.

- [`src/cart.ts`](src/cart.ts): `CartService` (business logic), `SessionAuthGuard`,
  `AddItemPipe` (DTO validation) and the explicitly registered `CartActions` group
  (`add-item` is idempotent and serial).
- [`src/main.ts`](src/main.ts): `ActionsModule.register` with session-based
  `resolveIdentity`, CSRF token per session, origin pinning, demo sign-in with
  session regeneration, and a strict CSP.
- [`browser/main.ts`](browser/main.ts): page script using the generated client
  from `browser/generated/` (created by `scripts/codegen.mjs`, git-ignored) and
  bundled by esbuild into `dist/public/app.js`. The product buttons are bound
  with the generated Live/HBS helper (`createActionBindings(actions).bindCartAddItem`,
  codegen target `live`), which reflects the call in `data-nv-action-state` and
  `aria-busy`.

```sh
pnpm build
pnpm --filter @nestvexa/example-actions-basic start
# open http://127.0.0.1:3111
```

As a guest, "Add a Nest mug" fails with `UNAUTHENTICATED` from the group guard.
Sign in and the same call succeeds. Calls without the CSRF header, with a forged
token, or from another origin are rejected before any effect; see
[tests/browser/actions.spec.ts](../../tests/browser/actions.spec.ts).

This is a local demonstration: the session secret is random per process, the
store is in memory, cookies are not `Secure` on plain HTTP, and sign-in accepts
any name. Production hosts supply real authentication, a persistent session
store, HTTPS and resource-level authorization.
