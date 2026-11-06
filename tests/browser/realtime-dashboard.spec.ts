import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exampleUrl } from './example-url.js';

const base = exampleUrl('realtime-dashboard', 3116);
const root = '[data-nv-name="dashboard"]';
// Multi-context flows on shared CI hosts: allow slow browsers.
test.describe.configure({ timeout: 90_000 });

async function open(browser: Browser, role: 'viewer' | 'operator') {
  const context = await browser.newContext();
  // Record the channel of every realtime message and every client error code.
  await context.addInitScript(() => {
    const seen: string[] = [];
    const failures: string[] = [];
    Reflect.set(window, 'nvChannels', seen);
    Reflect.set(window, 'nvErrors', failures);
    document.addEventListener('nestvexa:error', (event) => {
      const detail: unknown = Reflect.get(event, 'detail');
      const code: unknown =
        detail && typeof detail === 'object'
          ? Reflect.get(detail, 'code')
          : undefined;
      failures.push(typeof code === 'string' ? code : 'UNKNOWN');
    });
    window.addEventListener('nestvexa:realtime', (event) => {
      const detail: unknown = Reflect.get(event, 'detail');
      const channel: unknown =
        detail && typeof detail === 'object'
          ? Reflect.get(detail, 'channel')
          : undefined;
      if (typeof channel === 'string') seen.push(channel);
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const subscribed = page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await page.goto(base);
  if (role === 'operator') {
    await page
      .getByRole('button', { name: 'Switch to operator (demo)' })
      .click();
    await expect(page.locator('#viewer-role')).toHaveText('operator');
  }
  expect((await subscribed).status()).toBe(200);
  return { page, errors };
}
const count = async (page: Page, selector: string) =>
  Number(await page.locator(selector).textContent());
/** Channels of the signed (not encrypted) subscription token on the root. */
async function tokenChannels(page: Page): Promise<string[]> {
  const token =
    (await page.locator(root).getAttribute('data-nv-realtime')) ?? '';
  const [body] = token.split('.');
  const claims = JSON.parse(
    Buffer.from(body ?? '', 'base64url').toString('utf8'),
  ) as { c: string[] };
  return claims.c;
}

test('an order recorded in one browser refreshes another browser without reload', async ({
  browser,
}) => {
  const alice = await open(browser, 'viewer');
  const bob = await open(browser, 'viewer');
  await bob.page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  const before = await count(bob.page, '#metric-orders');
  await alice.page.getByRole('button', { name: 'Record a test order' }).click();
  await expect(alice.page.locator('#dashboard-notice')).toContainText(
    'recorded',
  );
  const recorded = await count(alice.page, '#metric-orders');
  expect(recorded).toBeGreaterThan(before);
  // Bob never acted: the published invalidation triggers his authorized refresh.
  await expect
    .poll(() => count(bob.page, '#metric-orders'))
    .toBeGreaterThanOrEqual(recorded);
  expect(
    await bob.page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
  ).toBe(true);
  await expect(bob.page.locator('#dashboard-notice')).toHaveText('');
  expect([...alice.errors, ...bob.errors]).toEqual([]);
  await alice.page.context().close();
  await bob.page.context().close();
});

test('presence lists other open dashboards and drops closed ones', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const alice = await open(browser, 'viewer');
  const bob = await open(browser, 'viewer');
  const bobName = (await bob.page.locator('#viewer-name').textContent()) ?? '';
  expect(bobName).toMatch(/^Viewer-[0-9A-F]{6}$/);
  await expect(alice.page.locator('#presence-list')).toContainText(bobName);
  expect(await count(alice.page, '#presence-count')).toBeGreaterThanOrEqual(2);
  await bob.page.context().close();
  // Heartbeats stop; the sweep drops Bob after the presence TTL.
  await expect(alice.page.locator('#presence-list')).not.toContainText(
    bobName,
    { timeout: 30_000 },
  );
  await alice.page.context().close();
});

test('operator incidents never reach viewers: token, refreshes and forged actions', async ({
  browser,
}) => {
  const operator = await open(browser, 'operator');
  const colleague = await open(browser, 'operator');
  const viewer = await open(browser, 'viewer');
  // Every dashboard declares the incidents channel; only operators get it signed.
  expect(await tokenChannels(operator.page)).toContain('incidents:ops');
  expect(await tokenChannels(viewer.page)).not.toContain('incidents:ops');
  expect(await tokenChannels(viewer.page)).toEqual(
    expect.arrayContaining(['metrics:global', 'presence:dashboard']),
  );
  await expect(viewer.page.locator('#incidents-restricted')).toBeVisible();

  // Validation first, then a real incident.
  await operator.page.getByRole('button', { name: 'Raise incident' }).click();
  await expect(operator.page.locator('#incident-error')).toHaveText(
    'Describe the incident in at least 3 characters.',
  );
  const title = `Disk pressure ${randomUUID().slice(0, 8)} <i>x</i>`;
  await operator.page.getByLabel('Incident title').fill(title);
  await operator.page.getByRole('button', { name: 'Raise incident' }).click();
  await expect(operator.page.locator('#incident-list')).toContainText(title);
  // Another operator refreshes from the incidents channel…
  await expect(colleague.page.locator('#incident-list')).toContainText(title);
  await expect(colleague.page.locator('#incident-list i')).toHaveCount(0);
  const channels = (page: Page) =>
    page.evaluate(() => Reflect.get(window, 'nvChannels') as string[]);
  expect(await channels(colleague.page)).toContain('incidents:ops');
  // …while the viewer's stream never carries it, so it never refreshes for
  // it, and the incident text never reaches the viewer's page.
  await viewer.page.waitForTimeout(750);
  expect(await channels(viewer.page)).not.toContain('incidents:ops');
  expect(await viewer.page.content()).not.toContain(title.slice(0, 20));
  // The same stream does deliver the channels the viewer may read.
  await operator.page
    .getByRole('button', { name: 'Record a test order' })
    .click();
  await expect.poll(() => channels(viewer.page)).toContain('metrics:global');
  expect(await channels(viewer.page)).not.toContain('incidents:ops');

  // A viewer cannot forge the operator action, even with valid session/CSRF.
  const dashboard = viewer.page.locator(root);
  const forged = await viewer.page.request.post(
    base + '/_nestvexa/live/dashboard/raiseIncident',
    {
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-nestvexa-csrf': (await dashboard.getAttribute('data-nv-csrf')) ?? '',
      },
      data: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: await dashboard.getAttribute('data-nv-snapshot'),
        revision: Number(await dashboard.getAttribute('data-nv-revision')),
        updates: { incidentDraft: 'Forged incident' },
      }),
    },
  );
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toMatchObject({ code: 'ACTION_FORBIDDEN' });
  // Nor can it reuse an operator's realtime token: tokens are identity-bound.
  const operatorToken =
    (await operator.page.locator(root).getAttribute('data-nv-realtime')) ?? '';
  const stolen = await viewer.page.request.get(
    `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(operatorToken)}`,
  );
  expect(stolen.status()).toBe(403);
  await expect(colleague.page.locator('#incident-list')).not.toContainText(
    'Forged incident',
  );
  for (const session of [operator, colleague, viewer])
    await session.page.context().close();
});

test('report job progress reaches its owner and completes', async ({
  browser,
}) => {
  const { page, errors } = await open(browser, 'viewer');
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.locator('#report-status')).toHaveText('succeeded');
  await expect(page.locator('#report-progress')).toHaveAttribute(
    'value',
    '100',
  );
  expect(errors).toEqual([]);
  await page.context().close();
});

test('a dashboard resumes realtime updates after the network drops and returns', async ({
  browser,
}) => {
  const alice = await open(browser, 'viewer');
  const bob = await open(browser, 'viewer');
  const notice = alice.page.locator('#dashboard-notice');
  /** Record an order from Alice and return the order count it produced. */
  const record = async () => {
    const previous = (await notice.textContent()) ?? '';
    await alice.page
      .getByRole('button', { name: 'Record a test order' })
      .click();
    await expect(notice).not.toHaveText(previous);
    return Number(/\d+/.exec((await notice.textContent()) ?? '')?.[0]);
  };
  const bobErrors = () =>
    bob.page.evaluate(() => Reflect.get(window, 'nvErrors') as string[]);

  // An event published during the outage.
  await bob.page.context().setOffline(true);
  const duringOutage = await record();
  await bob.page.waitForTimeout(1500);
  await bob.page.context().setOffline(false);
  // Either the reconnected stream replays the missed event and Bob catches
  // up, or (documented limitation) the stream was still open, the refresh it
  // triggered failed offline and the client reported NETWORK and suspended
  // the component; a reload is then the recovery path.
  await expect
    .poll(
      async () =>
        (await count(bob.page, '#metric-orders')) >= duringOutage ||
        (await bobErrors()).includes('NETWORK'),
      { timeout: 45_000 },
    )
    .toBe(true);
  if ((await bobErrors()).includes('NETWORK')) {
    const resubscribed = bob.page.waitForResponse((response) =>
      response.url().includes('/_nestvexa/realtime/sse?'),
    );
    await bob.page.reload();
    await resubscribed;
    expect(await count(bob.page, '#metric-orders')).toBeGreaterThanOrEqual(
      duringOutage,
    );
  }
  // After the outage, new events reach Bob live, without a reload.
  await bob.page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  const afterOutage = await record();
  await expect
    .poll(() => count(bob.page, '#metric-orders'), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(afterOutage);
  expect(
    await bob.page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
  ).toBe(true);
  await alice.page.context().close();
  await bob.page.context().close();
});

test('accessibility: viewer and operator dashboards pass automated checks', async ({
  browser,
}) => {
  for (const role of ['viewer', 'operator'] as const) {
    const { page } = await open(browser, role);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.context().close();
  }
});
