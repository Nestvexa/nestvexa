import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  workers: 2,
  // Shared CI runners are slow; a test that passes on retry is still reported as "flaky".
  retries: process.env.CI ? 2 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/reports/playwright.json' }],
  ],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @nestvexa/example-starter-live start',
      url: 'http://127.0.0.1:3102',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-starter-hbs start',
      url: 'http://127.0.0.1:3100',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-live-counter start',
      url: 'http://127.0.0.1:3101',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-basic start:e2e',
      url: 'http://127.0.0.1:3103',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-uploads start',
      url: 'http://127.0.0.1:3105/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-auth-forms start',
      url: 'http://127.0.0.1:3104/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-hybrid-dashboard start',
      url: 'http://127.0.0.1:3112/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-custom-engine start',
      url: 'http://127.0.0.1:3113',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-actions-basic start',
      url: 'http://127.0.0.1:3111/api/health',
      reuseExistingServer: false,
    },
    // Standalone distributed-live replicas for the WebSocket and `auto`
    // transport browser tests (the Redis two-replica suite is test:services).
    {
      command: 'pnpm --filter @nestvexa/example-distributed-live start',
      url: 'http://127.0.0.1:3226/api/health',
      env: { PORT: '3226', REALTIME_TRANSPORT: 'websocket' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-distributed-live start',
      url: 'http://127.0.0.1:3227/api/health',
      env: { PORT: '3227', REALTIME_TRANSPORT: 'auto' },
      reuseExistingServer: false,
    },
    // Explicit long-polling, and `auto` negotiating WebSocket on Fastify.
    {
      command: 'pnpm --filter @nestvexa/example-distributed-live start',
      url: 'http://127.0.0.1:3800/api/health',
      env: { PORT: '3800', REALTIME_TRANSPORT: 'polling' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-distributed-live start',
      url: 'http://127.0.0.1:3801/api/health',
      env: {
        PORT: '3801',
        REALTIME_TRANSPORT: 'auto',
        HTTP_ADAPTER: 'fastify',
      },
      reuseExistingServer: false,
    },
    // Phase 9-11 frontend adapters (Vite production builds + SSR). The React
    // example renders through the official Inertia SSR server process.
    {
      command: 'pnpm --filter @nestvexa/example-inertia-react start:ssr',
      url: 'http://127.0.0.1:13716/health',
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-react start:e2e',
      url: 'http://127.0.0.1:3106',
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-vue start:e2e',
      url: 'http://127.0.0.1:3107',
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-svelte start:e2e',
      url: 'http://127.0.0.1:3108',
      reuseExistingServer: false,
      timeout: 180000,
    },
    // Client-only mode (SSR disabled) of the same three builds.
    {
      command: 'pnpm --filter @nestvexa/example-inertia-react start:csr',
      url: 'http://127.0.0.1:3210',
      env: { PORT: '3210' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-vue start:csr',
      url: 'http://127.0.0.1:3211',
      env: { PORT: '3211' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-svelte start:csr',
      url: 'http://127.0.0.1:3212',
      env: { PORT: '3212' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-inertia-mixed start',
      url: 'http://127.0.0.1:3109/api/health',
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-directive-lab start',
      url: 'http://127.0.0.1:3360/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-admin-i18n start',
      url: 'http://127.0.0.1:3110/api/health',
      reuseExistingServer: false,
    },
    // Showcase examples (ports 3114-3123; see each example README).
    {
      command: 'pnpm --filter @nestvexa/example-starter-ejs start',
      url: 'http://127.0.0.1:3114/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-live-crud start',
      url: 'http://127.0.0.1:3115/api/health',
      reuseExistingServer: false,
    },
    {
      // The order simulator is off and presence expires quickly for the tests.
      command: 'pnpm --filter @nestvexa/example-realtime-dashboard start',
      url: 'http://127.0.0.1:3116/api/health',
      env: { DASHBOARD_TICK_MS: '0', PRESENCE_TTL_MS: '6000' },
      reuseExistingServer: false,
    },
    {
      // S3-compatible TEST DOUBLE (tests/support/fake-s3.ts) for upload-to-s3.
      command: 'pnpm exec tsx tests/support/fake-s3-server.ts',
      url: 'http://127.0.0.1:3118/__fake/objects',
      env: {
        FAKE_S3_PORT: '3118',
        FAKE_S3_CORS_ORIGIN: 'http://127.0.0.1:3117',
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-upload-to-s3 start',
      url: 'http://127.0.0.1:3117/api/health',
      env: {
        PORT: '3117',
        S3_ENDPOINT: 'http://127.0.0.1:3118',
        S3_REGION: 'us-test-1',
        S3_BUCKET: 'nestvexa-example',
        S3_ACCESS_KEY_ID: 'NESTVEXAEXAMPLEKEY',
        S3_SECRET_ACCESS_KEY: 'nestvexa-example-secret-0123456789',
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-multi-tenant start',
      url: 'http://127.0.0.1:3119/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-express-host start',
      url: 'http://127.0.0.1:3120/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-fastify-host start',
      url: 'http://127.0.0.1:3121/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @nestvexa/example-offline-progressive start',
      url: 'http://127.0.0.1:3122/api/health',
      reuseExistingServer: false,
    },
    {
      // One server running every VISION-029..037 route (apps/playground equivalent).
      command: 'pnpm --filter @nestvexa/example-integration-matrix start',
      url: 'http://127.0.0.1:3123/api/health',
      reuseExistingServer: false,
      timeout: 180000,
    },
    // The coherent showcase app (examples/showcase): one process, memory
    // broker, test mail transport, a fresh data directory per run.
    {
      command: 'pnpm --filter @nestvexa/example-showcase start',
      url: 'http://127.0.0.1:3124/api/health',
      env: {
        PORT: '3124',
        SHOWCASE_DATA_DIR: join(
          tmpdir(),
          `nestvexa-showcase-e2e-${process.pid}`,
        ),
      },
      reuseExistingServer: false,
      timeout: 180000,
    },
    // The CLI-generated reference app, with built assets and SSR (no Vite dev servers).
    {
      command: 'pnpm --filter @nestvexa/example-cli-generated start',
      url: 'http://127.0.0.1:3126',
      env: {
        PORT: '3126',
        NESTVEXA_ASSETS: 'build',
        NESTVEXA_ORIGIN: 'http://127.0.0.1:3126',
      },
      reuseExistingServer: false,
      timeout: 180000,
    },
    // Browser runtime lab: navigation, Alpine $live, reorder, reconnection, leaks.
    {
      command: 'pnpm --filter @nestvexa/example-browser-lab start',
      url: 'http://127.0.0.1:3860/api/health',
      env: { PORT: '3860' },
      reuseExistingServer: false,
    },
    // Islands built through Vite: production build and Vite dev middleware.
    {
      command: 'pnpm --filter @nestvexa/example-islands-vite start',
      url: 'http://127.0.0.1:3479',
      env: { PORT: '3479' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'pnpm --filter @nestvexa/example-islands-vite dev',
      url: 'http://127.0.0.1:3475',
      env: { PORT: '3475' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    // Inertia adapters in Vite dev mode (HMR), each from a disposable copy.
    {
      command: 'node tests/browser/hmr-fixture.mjs react',
      url: 'http://127.0.0.1:3476',
      env: { PORT: '3476' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'node tests/browser/hmr-fixture.mjs vue',
      url: 'http://127.0.0.1:3477',
      env: { PORT: '3477' },
      reuseExistingServer: false,
      timeout: 180000,
    },
    {
      command: 'node tests/browser/hmr-fixture.mjs svelte',
      url: 'http://127.0.0.1:3478',
      env: { PORT: '3478' },
      reuseExistingServer: false,
      timeout: 180000,
    },
  ],
});
