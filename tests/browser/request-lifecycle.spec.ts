import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('a timed-out committed action stops further client mutations and retains local drafts', async ({
  page,
}) => {
  await page.goto('/');
  await page.clock.install();
  const marker = page.locator('[data-nv-component]');
  const snapshot = await marker.getAttribute('data-nv-snapshot');
  const csrf = await marker.getAttribute('data-nv-csrf');
  if (!snapshot || !csrf) throw new Error('Missing host markers');
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  const release = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Slow increase', exact: true })
      .click();
    await release.started;
    await page
      .getByLabel('Display name', { exact: true })
      .fill('Keep this local draft');
    await page.clock.runFor(30_001);
    await expect(page.locator('#status')).toContainText('timed out');
  } finally {
    release();
    await release.wait();
  }
  await expect(marker).toHaveAttribute('aria-busy', 'false');
  await expect(marker).toHaveAttribute('data-nv-revision', '0');
  await expect(page.locator('#count')).toHaveText('0');
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    'Keep this local draft',
  );
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).press('Enter');
  await page.clock.runFor(1000);
  expect(requests).toBe(1);
  await expect(page.locator('#status')).toContainText('timed out');
  // The actual server action committed despite browser cancellation. Replaying
  // its old revision is rejected; this is not a fabricated successful response.
  const replay = await page.request.post('/_nestvexa/live/counter/increment', {
    headers: { origin: 'http://127.0.0.1:3101', 'x-nestvexa-csrf': csrf },
    data: {
      protocol: 'nestvexa-live/1',
      requestId: await page.evaluate(() => crypto.randomUUID()),
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    },
  });
  expect(replay.status()).toBe(409);
  await page.reload();
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
});

test('an actual stale-revision response stops queued mutations without repeated HTTP requests', async ({
  page,
}) => {
  await page.goto('/');
  const marker = page.locator('[data-nv-component]');
  const snapshot = await marker.getAttribute('data-nv-snapshot');
  const csrf = await marker.getAttribute('data-nv-csrf');
  if (!snapshot || !csrf) throw new Error('Missing host markers');
  const change = await page.request.post('/_nestvexa/live/counter/increment', {
    headers: { origin: 'http://127.0.0.1:3101', 'x-nestvexa-csrf': csrf },
    data: {
      protocol: 'nestvexa-live/1',
      requestId: await page.evaluate(() => crypto.randomUUID()),
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    },
  });
  expect(change.ok()).toBe(true);
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  await page
    .getByRole('button', { name: 'Increase', exact: true })
    .evaluate((element) => {
      if (!(element instanceof HTMLButtonElement))
        throw new Error('Missing action button');
      element.click();
      element.click();
      element.click();
    });
  await expect(page.locator('#status')).toContainText('409');
  await expect(marker).toHaveAttribute('aria-busy', 'false');
  expect(requests).toBe(1);
  await page.getByRole('button', { name: 'Decrease', exact: true }).click();
  expect(requests).toBe(1);
  await expect(page.locator('#count')).toHaveText('0');
});

test('a failed connection after an actual server response is not retried automatically', async ({
  page,
}) => {
  await page.goto('/');
  let requests = 0;
  let completed = () => {};
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  await page.route(
    '**/counter/increment',
    async (route) => {
      const actual = await route.fetch();
      expect(actual.ok()).toBe(true);
      await route.abort('connectionreset');
      completed();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await finished;
  await expect(page.locator('#status')).toContainText('reconcile server state');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await page.getByRole('button', { name: 'Decrease', exact: true }).click();
  expect(requests).toBe(1);
  await expect(page.locator('#count')).toHaveText('0');
});
