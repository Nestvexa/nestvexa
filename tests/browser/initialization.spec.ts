import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { holdResponse } from './transport.js';

const base = 'http://127.0.0.1:3102';

test('initialization runs once after Alpine starts and retains local state across real updates', async ({
  page,
}) => {
  const errors: string[] = [];
  const actions: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') actions.push(request.url());
  });
  const release = await holdResponse(page, '**/startup-panel/load');
  try {
    const response = await page.goto(base + '/init');
    expect(response?.headers()['content-security-policy']).toContain(
      "script-src 'self'",
    );
    await release.started;
    const root = page.locator('[data-nv-name=startup-panel]');
    await expect(root).toHaveAttribute('aria-busy', 'true');
    await expect(
      page.getByText('Loading content', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Local startup click' }).click();
    await expect(page.locator('#startup-local')).toHaveText('1');
    release();
    await release.wait();
    await expect(root).toHaveAttribute('data-nv-revision', '1');
    await expect(page.locator('#startup-message')).toHaveText(
      'Public sample content loaded',
    );
    await expect(page.locator('#startup-loads')).toHaveText('1');
    await expect(page.locator('#startup-local')).toHaveText('1');
    await page.getByRole('button', { name: 'Refresh startup panel' }).click();
    await expect(root).toHaveAttribute('data-nv-revision', '2');
    await expect(page.locator('#startup-refreshes')).toHaveText('1');
    // A persisted history entry keeps the existing component registration.
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.getByRole('button', { name: 'Refresh startup panel' }).click();
    await expect(root).toHaveAttribute('data-nv-revision', '3');
    await expect(page.locator('#startup-loads')).toHaveText('1');
    await expect(page.locator('#startup-local')).toHaveText('1');
    expect(actions.filter((url) => url.endsWith('/load'))).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    release();
    await release.wait();
  }
});

test('a denied initializer is not retried after a permitted refresh', async ({
  page,
}) => {
  const actions: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') actions.push(request.url());
  });
  const denied = page.waitForResponse((response) =>
    response.url().endsWith('/startup-denied/load'),
  );
  await page.goto(base + '/init/denied');
  expect((await denied).status()).toBe(403);
  const root = page.locator('[data-nv-name=startup-denied]');
  await expect(root).toHaveAttribute('aria-busy', 'false');
  await expect(root).toHaveAttribute('data-nv-revision', '0');
  await expect(page.locator('#startup-loads')).toHaveText('0');
  await page.getByRole('button', { name: 'Refresh startup panel' }).click();
  await expect(root).toHaveAttribute('data-nv-revision', '1');
  await expect(page.locator('#startup-refreshes')).toHaveText('1');
  await expect(page.locator('#startup-loads')).toHaveText('0');
  expect(actions.filter((url) => url.endsWith('/load'))).toHaveLength(1);
});

test('automatic actions still enforce CSRF and session ownership on real Nest endpoints', async ({
  page,
  browser,
}) => {
  await page.goto(base + '/init');
  const root = page.locator('[data-nv-name=startup-panel]');
  await expect(root).toHaveAttribute('data-nv-revision', '1');
  const marker = await root.evaluate((element) => ({
    endpoint: element.getAttribute('data-nv-endpoint'),
    snapshot: element.getAttribute('data-nv-snapshot'),
    csrf: element.getAttribute('data-nv-csrf'),
  }));
  if (!marker.endpoint || !marker.snapshot || !marker.csrf)
    throw new Error('Missing initialized component marker');
  const endpoint = new URL(marker.endpoint + '/load', base).href;
  const data = {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    revision: 1,
    snapshot: marker.snapshot,
    updates: {},
    input: null,
  };
  expect(
    (
      await page.request.post(endpoint, {
        headers: { origin: base, 'x-nestvexa-csrf': 'wrong' },
        data,
      })
    ).status(),
  ).toBe(403);
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    await guest.goto(base + '/init');
    await expect(guest.locator('[data-nv-name=startup-panel]')).toHaveAttribute(
      'data-nv-revision',
      '1',
    );
    const csrf = await guest
      .locator('[data-nv-name=startup-panel]')
      .getAttribute('data-nv-csrf');
    if (!csrf) throw new Error('Missing guest CSRF');
    expect(
      (
        await other.request.post(endpoint, {
          headers: { origin: base, 'x-nestvexa-csrf': csrf },
          data,
        })
      ).status(),
    ).toBe(410);
  } finally {
    await other.close();
  }
  const allowed = await page.request.post(endpoint, {
    headers: { origin: base, 'x-nestvexa-csrf': marker.csrf },
    data,
  });
  expect(allowed.status()).toBe(201);
  const result = (await allowed.json()) as { state: { loads: number } };
  expect(result.state.loads).toBe(2);
});

test('initial and loaded startup content passes automated accessibility checks', async ({
  page,
}) => {
  const release = await holdResponse(page, '**/startup-panel/load');
  try {
    await page.goto(base + '/init');
    await release.started;
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    release();
    await release.wait();
    await expect(page.locator('[data-nv-name=startup-panel]')).toHaveAttribute(
      'data-nv-revision',
      '1',
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    release();
    await release.wait();
  }
});

test('without JavaScript the initial HTML and ordinary navigation remain usable', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const mutations: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') mutations.push(request.url());
    });
    await page.goto(base + '/init');
    await expect(page.locator('#startup-message')).toHaveText(
      'Waiting for the authorized initialization request',
    );
    await expect(page.locator('[data-nv-name=startup-panel]')).toHaveAttribute(
      'data-nv-revision',
      '0',
    );
    await expect(
      page
        .getByRole('region', { name: 'Startup content' })
        .locator('noscript p'),
    ).toContainText('Automatic loading requires JavaScript');
    expect(mutations).toEqual([]);
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await expect(page).toHaveURL(base + '/about');
    const health = await context.request.get(base + '/api/health');
    expect(health.status()).toBe(200);
  } finally {
    await context.close();
  }
});
