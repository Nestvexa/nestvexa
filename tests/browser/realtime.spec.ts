import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// The root suite serves starter-live on 3102; local runs may override the origin.
const base =
  process.env['NESTVEXA_STARTER_LIVE_ORIGIN'] ?? 'http://127.0.0.1:3102';
const url = `${base}/realtime`;

test('an event published by one session refreshes another session through SSE', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const alice = await first.newPage();
  const bob = await second.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob])
    page.on('pageerror', (error) => errors.push(error.message));
  const subscribed = bob.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await alice.goto(url);
  await bob.goto(url);
  expect((await subscribed).status()).toBe(200);
  const board = bob.locator('[data-nv-name="realtime-board"]');
  const revision = Number(await board.getAttribute('data-nv-revision'));
  const refreshed = bob.waitForResponse((response) =>
    response.url().endsWith('/_nestvexa/live/realtime-board/_sync'),
  );
  const text = `Hello ${Date.now()} <b>escaped</b>`;
  await alice.locator('#realtime-draft').fill(text);
  await alice.getByRole('button', { name: 'Post update' }).click();
  await expect(alice.locator('#realtime-posted')).toHaveText('1');
  // Bob never acted: the published invalidation triggers his own authorized refresh.
  await expect(bob.locator('#realtime-feed li').first()).toHaveText(text);
  await expect(bob.locator('#realtime-feed b')).toHaveCount(0);
  await expect(bob.locator('#realtime-posted')).toHaveText('0');
  // The refresh is read-only: marked, draft-free, and the revision stays.
  const refresh = await refreshed;
  expect(refresh.request().headers()['x-nestvexa-resync']).toBe('1');
  expect(refresh.request().postDataJSON()).toMatchObject({ updates: {} });
  expect(await refresh.json()).toMatchObject({ component: { revision } });
  await expect(board).toHaveAttribute('data-nv-revision', String(revision));
  expect(errors).toEqual([]);
  await first.close();
  await second.close();
});

test('a server-pushed domain event runs the @OnEvent action in another session', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const alice = await first.newPage();
  const bob = await second.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob])
    page.on('pageerror', (error) => errors.push(error.message));
  const subscribed = bob.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await alice.goto(url);
  await bob.goto(url);
  expect((await subscribed).status()).toBe(200);
  const name = `Ada ${Date.now()}`;
  await alice.locator('#realtime-draft').fill(name);
  // Bob's browser delivers the event to his component's listener action
  // through his own authorized Live route, not a generic refresh.
  const delivered = bob.waitForRequest((request) =>
    request.url().endsWith('/_nestvexa/live/realtime-board/announcementPosted'),
  );
  // Delivery is at-most-once: an event published before Bob's stream finished
  // subscribing on the server is not replayed, so announce again until it lands.
  await expect(async () => {
    await alice.getByRole('button', { name: 'Announce to everyone' }).click();
    await expect(bob.locator('#realtime-announcements li').first()).toHaveText(
      `Announcement from ${name}`,
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 40_000 });
  const request = await delivered;
  expect(request.postDataJSON()).toMatchObject({
    input: { id: expect.any(Number) },
  });
  await expect(alice.locator('#realtime-announcements li').first()).toHaveText(
    `Announcement from ${name}`,
  );
  expect(errors).toEqual([]);
  await first.close();
  await second.close();
});

// Job snapshots arrive over realtime; allow for slow CI browsers.
const job = { timeout: 15_000 };

test('report job progress reaches only its owner and completes', async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.locator('#report-status')).toHaveText('succeeded', job);
  await expect(page.locator('#report-progress')).toHaveAttribute(
    'value',
    '100',
  );
});

test('a running report can be cancelled by its owner', async ({ page }) => {
  await page.goto(url);
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.locator('#report-status')).toHaveText(/queued|running/);
  await page.getByRole('button', { name: 'Cancel report' }).click();
  await expect(page.locator('#report-status')).toHaveText('cancelled', job);
  await expect(
    page.getByRole('button', { name: 'Retry report' }),
  ).toBeVisible();
});

test('a failing report is retried automatically, fails with a generic message and can be retried', async ({
  page,
}) => {
  await page.goto(url);
  await page.getByRole('button', { name: 'Generate failing report' }).click();
  await expect(page.locator('#report-status')).toHaveText('failed', job);
  // Two automatic attempts ran before the job failed.
  await expect(page.locator('#report-attempts')).toHaveText('2');
  await expect(page.locator('#report-error')).toHaveText('The job failed.');
  await expect(page.locator('body')).not.toContainText(
    'demo report source offline',
  );
  await page.getByRole('button', { name: 'Retry report' }).click();
  await expect(page.locator('#report-status')).toHaveText('succeeded', job);
  await expect(page.locator('#report-attempts')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Retry report' })).toHaveCount(
    0,
  );
});

test('realtime subscriptions reject forged and foreign tokens', async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const other = await browser.newContext();
  const page = await owner.newPage();
  await page.goto(url);
  const token = await page
    .locator('[data-nv-name="realtime-board"]')
    .getAttribute('data-nv-realtime');
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const foreign = await other.newPage();
  await foreign.goto(url);
  const stolen = await foreign.request.get(
    `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(token ?? '')}`,
  );
  expect(stolen.status()).toBe(403);
  const forged = await page.request.get(
    `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(
      (token ?? '').replace(/.$/, (character) =>
        character === 'A' ? 'B' : 'A',
      ),
    )}`,
  );
  expect(forged.status()).toBe(403);
  await owner.close();
  await other.close();
});

test('accessibility: realtime board passes automated checks', async ({
  page,
}) => {
  await page.goto(url);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
