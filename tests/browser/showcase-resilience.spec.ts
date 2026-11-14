import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * examples/showcase failure states. This spec owns its server process so it
 * can stop and restart it mid-session: file sessions and stable secrets (as
 * a deployment would have) keep the user signed in across the restart.
 * `NV_SHOWCASE_RESILIENCE_PORT` pins the port (plus the worker index);
 * otherwise the OS picks a free one.
 */
const root = fileURLToPath(
  new URL('../../examples/showcase/', import.meta.url),
);
const password = 'showcase-demo-2026';
test.describe.configure({ mode: 'serial', timeout: 240_000 });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

let port = 0;
let base = '';
let dataDir = '';
let server: ChildProcess | undefined;
const env = {
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  REALTIME_SECRET: randomBytes(48).toString('base64url'),
};

async function start(): Promise<void> {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      SHOWCASE_DATA_DIR: dataDir,
      SHOWCASE_INSTANCE: 'resilience',
      SESSION_STORE: 'file',
      SHOWCASE_TEST_FAULTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const deadline = Date.now() + 120_000;
  let last: string;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`showcase exited early:\n${output}`);
    try {
      const health = await fetch(base + '/api/health');
      if (health.ok) return;
      last = `HTTP ${health.status}`;
    } catch (error) {
      // Not listening yet.
      last = error instanceof Error ? String(error.cause ?? error.message) : '';
    }
    if (Date.now() > deadline)
      throw new Error(`showcase did not start (${last}):\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function stop(): Promise<void> {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // An abrupt stop (no graceful shutdown), as in a crash or a killed pod.
  child.kill('SIGKILL');
  await exited;
}

test.beforeAll(async () => {
  const pinned = Number(process.env['NV_SHOWCASE_RESILIENCE_PORT'] ?? 0);
  port = pinned ? pinned + test.info().parallelIndex : await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'nestvexa-showcase-resilience-'));
  await start();
});
test.afterAll(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(base + '/app');
}
async function axe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}

test('an unexpected error renders a translated 500 page without details; the API keeps JSON', async ({
  page,
}) => {
  const response = await page.goto(base + '/__faults/error');
  expect(response?.status()).toBe(500);
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self'",
  );
  expect(response?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Something went wrong',
  );
  await expect(page.locator('#error-reference')).toHaveText(/^[0-9a-f]{8}$/);
  const html = await page.content();
  expect(html).not.toContain('Simulated failure');
  expect(html).not.toContain('errors.js');
  await axe(page);
  // In Arabic, right to left.
  await page.goto(base + '/__faults/error?lang=ar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'حدث خطأ ما',
  );
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await axe(page);
  // A non-page request gets Nest's generic JSON 500, also without details.
  const api = await page.request.get(base + '/__faults/error', {
    headers: { accept: 'application/json' },
  });
  expect(api.status()).toBe(500);
  expect(await api.json()).toEqual({
    statusCode: 500,
    message: 'Internal server error',
  });
});

test('a slow network shows the loading state, disables the action and marks the component busy', async ({
  page,
}) => {
  await signIn(page, 'ada@harbor.test');
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    '**/_nestvexa/live/metrics-panel/logDeployment',
    async (route) => {
      await held;
      await route.continue();
    },
  );
  const panel = page.locator('[data-nv-component]:has(#metrics-heading)');
  const button = page.getByRole('button', { name: 'Log a deployment' });
  await expect(page.locator('#metrics-saving')).toBeHidden();
  await button.click();
  await expect(page.locator('#metrics-saving')).toBeVisible();
  await expect(page.locator('#metrics-saving')).toHaveText('Saving…');
  await expect(page.locator('#metrics-saving')).toHaveAttribute(
    'role',
    'status',
  );
  await expect(button).toBeDisabled();
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  await expect(page.locator('#metrics-saving')).toBeHidden();
  await expect(button).toBeEnabled();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
});

test('the server stops mid-session: offline and reconnect states, and recovery replays no mutation', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page, 'ben@harbor.test');
  const deployments = page.locator('#metric-deployments');
  await expect(page.locator('#metrics-heading')).toHaveText('Live metrics');
  // One committed action before the outage (persisted with the data file).
  await page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  const before = Number(await deployments.textContent());
  expect(before).toBeGreaterThan(0);
  // Let the coalesced data write (100 ms) land, then stop the process hard.
  await page.waitForTimeout(500);
  await stop();

  // The action cannot reach the server: nothing is committed, the component
  // suspends (its last action may or may not have run) and both the panel's
  // offline notice and the page's connection banner say so.
  const banner = page.locator('#connection-status');
  await page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toHaveAttribute('data-state', 'lost');
  await expect(page.locator('#connection-message')).toHaveText(
    'The connection to the server was lost. Retrying…',
  );
  await expect(page.locator('#metrics-offline')).toBeVisible();
  await expect(
    page.locator('[data-nv-component]:has(#metrics-heading)'),
  ).toHaveAttribute('data-nv-suspended', '');
  await axe(page);

  // Restart. From here on, record every Live request the page sends.
  const live: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/_nestvexa/live/')) live.push(request.url());
  });
  await start();
  await expect(banner).toHaveAttribute('data-state', 'restored', {
    timeout: 30_000,
  });
  await expect(page.locator('#connection-message')).toHaveText(
    'The connection is back. Your last change may not have been saved. Reload the page to see the current data.',
  );
  // Recovery resends nothing by itself.
  await page.waitForTimeout(1500);
  expect(live).toEqual([]);
  await axe(page);

  await page.getByRole('button', { name: 'Reload the page' }).click();
  // Still signed in after the restart; the failed click was never replayed.
  await expect(page).toHaveURL(base + '/app');
  await expect(page.locator('#who')).toHaveText('Ben Ortiz (member)');
  await expect(deployments).toHaveText(String(before));
  await expect(banner).toBeHidden();
  await expect(page.locator('#metrics-offline')).toBeHidden();
  expect(live.filter((url) => url.includes('logDeployment'))).toEqual([]);
  // The page works again: exactly one new deployment per click.
  await page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  await expect(deployments).toHaveText(String(before + 1));
});
