import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/*
 * examples/showcase as two instances sharing one real Redis: the realtime
 * broker (RedisRealtimeBroker) and the dashboard metrics and inboxes
 * (SharedState). Each browser talks to one instance directly; sessions are
 * per instance, so every account signs in where it browses. Run through
 * `pnpm test:services` (playwright.services.config.ts starts both instances).
 */
const instanceA = process.env['NV_SHOWCASE_A_URL'] ?? 'http://127.0.0.1:3223';
const instanceB = process.env['NV_SHOWCASE_B_URL'] ?? 'http://127.0.0.1:3224';
const password = 'showcase-demo-2026';
// Sign-in uses scrypt by design and every test opens several accounts.
test.describe.configure({ timeout: 180_000 });

interface Session {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly errors: string[];
}
async function signIn(
  browser: Browser,
  base: string,
  email: string,
): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.flash').first()).toContainText('Signed in as');
  return { context, page, errors };
}
/** Opens the dashboard and waits until its realtime stream is connected. */
async function openDashboard(page: Page, base: string): Promise<void> {
  const stream = page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await page.goto(base + '/app');
  expect((await stream).status()).toBe(200);
}
const number = async (page: Page, selector: string) =>
  Number(await page.locator(selector).textContent());

test('both instances report the Redis broker', async ({ request }) => {
  const a = (await (
    await request.get(instanceA + '/api/health')
  ).json()) as Record<string, unknown>;
  const b = (await (
    await request.get(instanceB + '/api/health')
  ).json()) as Record<string, unknown>;
  expect(a).toMatchObject({ status: 'ok', realtime: 'redis', redis: true });
  expect(b).toMatchObject({ status: 'ok', realtime: 'redis', redis: true });
  expect(a['instance']).not.toBe(b['instance']);
});

test('a deployment logged on instance B refreshes a dashboard on instance A, for the same workspace only', async ({
  browser,
}) => {
  const ada = await signIn(browser, instanceA, 'ada@harbor.test');
  const ben = await signIn(browser, instanceB, 'ben@harbor.test');
  const cleo = await signIn(browser, instanceA, 'cleo@summit.test');
  await openDashboard(ada.page, instanceA);
  await openDashboard(ben.page, instanceB);
  await openDashboard(cleo.page, instanceA);
  const renderedA = await ada.page.locator('#rendered-by').textContent();
  const renderedB = await ben.page.locator('#rendered-by').textContent();
  expect(renderedA).not.toBe(renderedB);
  await ada.page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));

  const before = await number(ada.page, '#metric-deployments');
  const cleoBefore = await number(cleo.page, '#metric-deployments');
  await ben.page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(ben.page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  // Ben's own panel and Ada's panel on the other instance read the same Redis numbers.
  await expect(ben.page.locator('#metric-deployments')).toHaveText(
    String(before + 1),
  );
  await expect(ada.page.locator('#metric-deployments')).toHaveText(
    String(before + 1),
  );
  await expect(ada.page.locator('#metric-last')).toContainText(
    'Ben Ortiz logged a deployment',
  );
  await expect(ada.page.locator('#rendered-by')).toHaveText(renderedA ?? '');
  expect(
    await ada.page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
  ).toBe(true);
  // Presence is per instance by design: Ben is connected to B, not A.
  await expect(ada.page.locator('#presence-list')).toContainText('Ada Park');
  await expect(ada.page.locator('#presence-list')).not.toContainText(
    'Ben Ortiz',
  );
  // Cleo shares instance A with Ada but belongs to another workspace.
  await ada.page.waitForTimeout(500);
  await expect(cleo.page.locator('#metric-deployments')).toHaveText(
    String(cleoBefore),
  );
  await expect(cleo.page.locator('#metric-last')).not.toContainText(
    'Ben Ortiz',
  );
  for (const session of [ada, ben, cleo]) {
    expect(session.errors).toEqual([]);
    await session.context.close();
  }
});

test('a task assigned on instance A notifies the assignee on instance B in realtime, and nobody else', async ({
  browser,
}) => {
  const title = `Cross-instance handoff ${Date.now().toString(36)}`;
  const ben = await signIn(browser, instanceB, 'ben@harbor.test');
  const dev = await signIn(browser, instanceB, 'dev@summit.test');
  await openDashboard(ben.page, instanceB);
  await openDashboard(dev.page, instanceB);
  const ada = await signIn(browser, instanceA, 'ada@harbor.test');
  await ada.page.goto(instanceA + '/app/tasks');
  await ada.page.getByRole('button', { name: 'New task' }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Assignee').selectOption({ label: 'Ben Ortiz' });
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(ada.page.locator('#task-notice')).toHaveText(
    `Created “${title}”.`,
  );

  await expect(ben.page.locator('#inbox')).toContainText(
    `Ada Park assigned you “${title}”`,
  );
  await ben.page.waitForTimeout(500);
  await expect(dev.page.locator('#inbox')).not.toContainText(title);
  for (const session of [ada, ben, dev]) {
    expect(session.errors).toEqual([]);
    await session.context.close();
  }
});

test('a realtime token signed by instance A is refused on instance B for another account', async ({
  browser,
}) => {
  const ben = await signIn(browser, instanceA, 'ben@harbor.test');
  await openDashboard(ben.page, instanceA);
  const token =
    (await ben.page
      .locator('[data-nv-name="metrics-panel"]')
      .getAttribute('data-nv-realtime')) ?? '';
  expect(token).not.toBe('');
  // The instances share the realtime secret, so the token verifies on B,
  // but the identity binding names Ben's session on A: Cleo's session on B is refused.
  const cleo = await signIn(browser, instanceB, 'cleo@summit.test');
  const stolen = await cleo.page.request.get(
    `${instanceB}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
  );
  expect(stolen.status()).toBe(403);
  for (const session of [ben, cleo]) await session.context.close();
});
