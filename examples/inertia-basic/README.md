# Inertia basic (official React client)

Run `pnpm build`, then `pnpm --filter @nestvexa/example-inertia-basic start`
and visit `http://127.0.0.1:3103`.

A Nest/Express server using `@nestvexa/inertia`, `express-session` and a
host-owned XSRF guard. The browser bundle (`client/app.tsx`, built with esbuild
into `dist/public/app.js`) uses the **official** `@inertiajs/react` 3.10.0 and
`@inertiajs/core` 3.10.0 packages; there is no custom router.

It demonstrates the initial HTML page object, `<Link>` XHR navigation, a
deferred prop rendered with `<Deferred>`, an optional prop loaded with
`router.reload({ only: ['extra'] })`, `useForm` validation errors redirected
back through the session, a flash message after a redirect, and the XSRF cookie
round trip. `tests/browser/inertia.spec.ts` drives all of these in Chromium,
Firefox and WebKit, plus a full reload after an asset-version change.

`start:e2e` adds `--test-controls`, which enables `POST /__test/version` to bump
the asset version of the calling session only. Never enable it in production.

This is a client-side rendered demo. React/Vite integration, code splitting and
SSR belong to `@nestvexa/react` (Phase 9). The in-memory user list and memory
session store are for demonstration only.
