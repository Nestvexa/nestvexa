# Ports

Fixed ports used by the repository. Everything binds `127.0.0.1`. Integration tests
in `tests/*.test.ts` listen on port `0` (an ephemeral port chosen by the OS), so they
never collide.

## Examples and the root browser suite

The root [playwright.config.ts](../../playwright.config.ts) starts these servers for
`pnpm test:e2e`. Each example's default comes from `PORT ?? <default>` in its
`src/main.ts`.

| Port  | Example / process                                 | Health URL used by Playwright |
| ----- | ------------------------------------------------- | ----------------------------- |
| 3100  | `@nestvexa/example-starter-hbs`                   | `/`                           |
| 3101  | `@nestvexa/example-live-counter`                  | `/`                           |
| 3102  | `@nestvexa/example-starter-live`                  | `/`                           |
| 3103  | `@nestvexa/example-inertia-basic`                 | `/`                           |
| 3104  | `@nestvexa/example-auth-forms`                    | `/api/health`                 |
| 3105  | `@nestvexa/example-uploads`                       | `/api/health`                 |
| 3106  | `@nestvexa/example-inertia-react`                 | `/`                           |
| 3107  | `@nestvexa/example-inertia-vue`                   | `/`                           |
| 3108  | `@nestvexa/example-inertia-svelte`                | `/`                           |
| 3109  | `@nestvexa/example-inertia-mixed`                 | `/api/health`                 |
| 3110  | `@nestvexa/example-admin-i18n`                    | `/api/health`                 |
| 3111  | `@nestvexa/example-actions-basic`                 | `/api/health`                 |
| 3112  | `@nestvexa/example-hybrid-dashboard`              | `/api/health`                 |
| 3113  | `@nestvexa/example-custom-engine`                 | `/`                           |
| 13716 | Inertia React SSR server (`start:ssr`, `SSR_URL`) | `/health`                     |

A new example takes the next free port from 3114 upwards. Add its `webServer` entry to
`playwright.config.ts` and a row here in the same pull request.

## Parallel work

`pnpm test:e2e` starts **every** server above. Two runs on one machine, or a run next to
a manually started example, collide. When several people or agents share a machine:

- Give each workstream a private range (for example 3400–3419, 3420–3439) and start
  examples with `PORT=<port>`.
- For browser tests, write an uncommitted `playwright.local.config.ts` that starts only
  your servers on your ports, then run
  `pnpm exec playwright test -c playwright.local.config.ts <spec> --project=chromium`.
- Never commit a local config or a changed default port.

## External services

`pnpm test:services` ([scripts/services-check.mjs](../../scripts/services-check.mjs))
does not choose ports itself. It runs each section only when its variables are set,
for example `NESTVEXA_REDIS_PORT`, `NESTVEXA_CLAMD_HOST`/`NESTVEXA_CLAMD_PORT` and the
`NESTVEXA_S3_*` settings. [Production services](../guides/production-services.md) has
the Docker commands; map containers to host ports that do not clash with the table
above.
