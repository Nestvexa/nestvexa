# HBS starter

From repository root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm dev`. Visit `http://127.0.0.1:3100`, `/about`, `/contact` and `/api/health`. `PORT` can override the local port. Production sample: `pnpm --filter @nestvexa/example-starter-hbs start` after build.

The same view directory is resolved from both source and compiled entry points. Normal HTML links work without JavaScript. This is an MVC foundation, not the required complete showcase or auth starter. It includes no credentials, sessions or authentication claims.

`/contact` is a progressive-enhancement form fallback ([`src/contact.ts`](src/contact.ts), [`views/contact.hbs`](views/contact.hbs)): a plain POST that works without JavaScript. The server validates every field (repeated or non-text fields are refused, not coerced), re-renders the form with `422`, the submitted values and accessible errors (`aria-invalid`, `aria-describedby`, an error summary with links), and redirects with `303` on success. Foreign `Origin` headers get `403`; add a CSRF token as soon as the app has sessions. Nothing is stored. [`tests/browser/mvc.spec.ts`](../../tests/browser/mvc.spec.ts) drives it with JavaScript disabled and enabled.
