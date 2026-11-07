import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Multi-replica acceptance test against a real Redis (see
 * docs/guides/production-services.md). Run through `pnpm test:services` with
 * NESTVEXA_REDIS_PORT set; not part of `pnpm test:e2e`.
 *
 *   browser ──► proxy :base+2 ──► a :base   Express, SSE        ─┐
 *                           ├──► b :base+1 Express, WebSocket   │
 *                           ├──► c :base+3 Fastify, SSE         ├─► Redis
 *                           └──► d :base+4 Fastify, WebSocket  ─┘
 *
 * examples/showcase runs as two more instances on base+5 and base+6.
 *
 * NESTVEXA_ACCEPT_BASE_PORT (default 3220) moves all seven ports together.
 */
const redisPort = process.env['NESTVEXA_REDIS_PORT'];
if (!redisPort)
  throw new Error('NESTVEXA_REDIS_PORT is required for the services suite');
const base = Number(process.env['NESTVEXA_ACCEPT_BASE_PORT'] ?? 3220);
if (!Number.isSafeInteger(base) || base < 1024 || base > 65_000)
  throw new Error('NESTVEXA_ACCEPT_BASE_PORT must be a port number');
export const ports = {
  a: base,
  b: base + 1,
  proxy: base + 2,
  c: base + 3,
  d: base + 4,
  showcaseA: base + 5,
  showcaseB: base + 6,
};
// Read by tests/services/showcase-redis.spec.ts in the Playwright workers.
process.env['NV_SHOWCASE_A_URL'] ??= `http://127.0.0.1:${ports.showcaseA}`;
process.env['NV_SHOWCASE_B_URL'] ??= `http://127.0.0.1:${ports.showcaseB}`;
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
  PUBLIC_ORIGIN: `http://127.0.0.1:${ports.proxy}`,
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
  port: number,
  extra: Record<string, string>,
) => ({
  command,
  url: `http://127.0.0.1:${port}/api/health`,
  env: { ...env, ...extra },
  reuseExistingServer: false,
  timeout: 240_000,
});
const replica = (
  name: 'a' | 'b' | 'c' | 'd',
  adapter: 'express' | 'fastify',
  transport: 'sse' | 'websocket',
) =>
  server(
    'pnpm --filter @nestvexa/example-distributed-live start',
    ports[name],
    {
      PORT: String(ports[name]),
      REPLICA: name,
      HTTP_ADAPTER: adapter,
      REALTIME_TRANSPORT: transport,
    },
  );

export default defineConfig({
  testDir: './tests/services',
  workers: 1,
  timeout: 90_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/reports/playwright-services.json' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${ports.proxy}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    replica('a', 'express', 'sse'),
    replica('b', 'express', 'websocket'),
    replica('c', 'fastify', 'sse'),
    replica('d', 'fastify', 'websocket'),
    server(
      'pnpm --filter @nestvexa/example-distributed-live start:proxy',
      ports.proxy,
      {
        PROXY_PORT: String(ports.proxy),
        TARGET_A: `http://127.0.0.1:${ports.a}`,
        TARGET_B: `http://127.0.0.1:${ports.b}`,
        TARGET_C: `http://127.0.0.1:${ports.c}`,
        TARGET_D: `http://127.0.0.1:${ports.d}`,
      },
    ),
    // examples/showcase as two instances on the same Redis
    // (tests/services/showcase-redis.spec.ts); each is its own origin.
    ...(['a', 'b'] as const).map((name) => {
      const port = String(name === 'a' ? ports.showcaseA : ports.showcaseB);
      return server(
        'pnpm --filter @nestvexa/example-showcase start',
        Number(port),
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
