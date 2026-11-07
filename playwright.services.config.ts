import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Two-replica acceptance test against a real Redis (see
 * docs/guides/production-services.md). Run through `pnpm test:services` with
 * NESTVEXA_REDIS_PORT set; not part of `pnpm test:e2e`.
 *
 *   browser ──► proxy :3222 ──► replica a :3220 (SSE)       ─┐
 *                         └──► replica b :3221 (WebSocket) ─┴─► Redis
 */
const redisPort = process.env['NESTVEXA_REDIS_PORT'];
if (!redisPort)
  throw new Error('NESTVEXA_REDIS_PORT is required for the services suite');
const shared = {
  REDIS_HOST: process.env['NESTVEXA_REDIS_HOST'] ?? '127.0.0.1',
  REDIS_PORT: redisPort,
  ...(process.env['NESTVEXA_REDIS_PASSWORD']
    ? { REDIS_PASSWORD: process.env['NESTVEXA_REDIS_PASSWORD'] }
    : {}),
  // A fresh namespace per run keeps runs and other applications apart.
  REDIS_PREFIX: `nvaccept${randomBytes(4).toString('hex')}:`,
  REALTIME_SECRET: randomBytes(48).toString('base64url'),
  IDENTITY_SECRET: randomBytes(48).toString('base64url'),
  PUBLIC_ORIGIN: 'http://127.0.0.1:3222',
};
// Playwright evaluates this file in its workers too: keep one namespace.
for (const [key, value] of Object.entries(shared))
  process.env[`NESTVEXA_ACCEPT_${key}`] ??= value;
const env = Object.fromEntries(
  Object.keys(shared).map((key) => [
    key,
    process.env[`NESTVEXA_ACCEPT_${key}`] ?? '',
  ]),
);
const server = (
  command: string,
  url: string,
  extra: Record<string, string>,
) => ({
  command,
  url,
  env: { ...env, ...extra },
  reuseExistingServer: false,
  timeout: 240_000,
});

export default defineConfig({
  testDir: './tests/services',
  workers: 1,
  timeout: 60_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/reports/playwright-services.json' }],
  ],
  use: { baseURL: 'http://127.0.0.1:3222', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    server(
      'pnpm --filter @nestvexa/example-distributed-live start',
      'http://127.0.0.1:3220/api/health',
      { PORT: '3220', REPLICA: 'a', REALTIME_TRANSPORT: 'sse' },
    ),
    server(
      'pnpm --filter @nestvexa/example-distributed-live start',
      'http://127.0.0.1:3221/api/health',
      { PORT: '3221', REPLICA: 'b', REALTIME_TRANSPORT: 'websocket' },
    ),
    server(
      'pnpm --filter @nestvexa/example-distributed-live start:proxy',
      'http://127.0.0.1:3222/api/health',
      {
        PROXY_PORT: '3222',
        TARGET_A: 'http://127.0.0.1:3220',
        TARGET_B: 'http://127.0.0.1:3221',
      },
    ),
    // examples/showcase as two instances on the same Redis
    // (tests/services/showcase-redis.spec.ts); each is its own origin.
    ...(['a', 'b'] as const).map((name, index) => {
      const port = String(3223 + index);
      return server(
        'pnpm --filter @nestvexa/example-showcase start',
        `http://127.0.0.1:${port}/api/health`,
        {
          PORT: port,
          PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
          SHOWCASE_INSTANCE: `showcase-${name}`,
          SHOWCASE_DATA_DIR: join(
            tmpdir(),
            `nestvexa-showcase-services-${port}`,
          ),
        },
      );
    }),
  ],
});
