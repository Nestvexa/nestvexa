import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 2,
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
  ],
});
