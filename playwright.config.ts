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
      command: 'pnpm --filter @nestvexa/example-uploads start',
      url: 'http://127.0.0.1:3105/api/health',
      reuseExistingServer: false,
    },
  ],
});
