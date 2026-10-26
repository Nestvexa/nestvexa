# HBS starter

From repository root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm dev`. Visit `http://127.0.0.1:3100`, `/about`, and `/api/health`. `PORT` can override the local port. Production sample: `pnpm --filter @nestvexa/example-starter-hbs start` after build.

The same view directory is resolved from both source and compiled entry points. Normal HTML links work without JavaScript. This is an MVC foundation, not the required complete showcase or auth starter. It includes no credentials, mutation forms, sessions, or authentication claims.
