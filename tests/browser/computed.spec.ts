import { expect, test } from '@playwright/test';

const base = 'http://127.0.0.1:3102';
test('async computed text renders initially and recomputes through authorized actions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/init');
  const root = page.locator('[data-nv-name=startup-panel]');
  await expect(root).toHaveAttribute('data-nv-revision', '1');
  await expect(page.locator('#startup-summary')).toHaveText(
    '1 loads and 0 refreshes',
  );
  await page.getByRole('button', { name: 'Local startup click' }).click();
  await page.getByRole('button', { name: 'Refresh startup panel' }).click();
  await expect(root).toHaveAttribute('data-nv-revision', '2');
  await expect(page.locator('#startup-summary')).toHaveText(
    '1 loads and 1 refreshes',
  );
  await expect(page.locator('#startup-local')).toHaveText('1');
  const state = await root.evaluate(
    (element) =>
      JSON.parse(element.getAttribute('data-nv-state') ?? '{}') as Record<
        string,
        unknown
      >,
  );
  expect(Object.hasOwn(state, 'activitySummary')).toBe(false);
  expect(errors).toEqual([]);
});

test('computed methods cannot be invoked as actions or forged as writable state', async ({
  page,
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
    throw new Error('Missing computed fixture marker');
  const payload = {
    protocol: 'nestvexa-live/1',
    requestId: crypto.randomUUID(),
    snapshot: marker.snapshot,
    revision: 1,
    updates: {},
    input: null,
  };
  const headers = { origin: base, 'x-nestvexa-csrf': marker.csrf };
  expect(
    (
      await page.request.post(
        new URL(marker.endpoint + '/activitySummary', base).href,
        { headers, data: payload },
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.post(
        new URL(marker.endpoint + '/refresh', base).href,
        {
          headers,
          data: {
            ...payload,
            requestId: crypto.randomUUID(),
            updates: { activitySummary: 'forged' },
          },
        },
      )
    ).status(),
  ).toBe(422);
  await page.getByRole('button', { name: 'Refresh startup panel' }).click();
  await expect(root).toHaveAttribute('data-nv-revision', '2');
  await expect(page.locator('#startup-summary')).toHaveText(
    '1 loads and 1 refreshes',
  );
});

test('async computed initial HTML remains available when JavaScript is disabled', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(base + '/init');
    await expect(page.locator('#startup-summary')).toHaveText(
      '0 loads and 0 refreshes',
    );
    await expect(page.locator('[data-nv-name=startup-panel]')).toHaveAttribute(
      'data-nv-revision',
      '0',
    );
  } finally {
    await context.close();
  }
});
