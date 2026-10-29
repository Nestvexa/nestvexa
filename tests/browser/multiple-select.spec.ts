import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { holdResponse } from './transport.js';
import { randomUUID } from 'node:crypto';

test.use({ baseURL: 'http://127.0.0.1:3102' });
async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return errors;
}
async function selected(
  page: Page,
  selector = '#interests',
): Promise<string[]> {
  return page
    .locator(selector)
    .evaluate((element) =>
      [...(element as HTMLSelectElement).selectedOptions].map(
        (option) => option.value,
      ),
    );
}
test('multiple-select change synchronizes typed array state, mirrors choices and acknowledges a save', async ({
  page,
}) => {
  const errors = await start(page);
  await page
    .getByLabel('Interests', { exact: true })
    .selectOption(['build', 'review']);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(await selected(page, '#interests-alias')).toEqual(['build', 'review']);
  await expect(page.locator('#interests-dirty')).toBeHidden();
  await page
    .getByRole('button', { name: 'Save interests', exact: true })
    .click();
  await expect(page.locator('#saved-interests')).toHaveText('build review');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '2',
  );
  expect(errors).toEqual([]);
});
test('empty multiple selection is a real empty array, and native reset submits no request', async ({
  page,
}) => {
  const errors = await start(page);
  await page.getByLabel('Interests', { exact: true }).selectOption([]);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await page
    .getByLabel('Interests mirror', { exact: true })
    .selectOption(['review']);
  expect(await selected(page)).toEqual(['review']);
  await page
    .getByRole('button', { name: 'Reset interests', exact: true })
    .click();
  expect(await selected(page)).toEqual([]);
  expect(await selected(page, '#interests-alias')).toEqual([]);
  await expect(page.locator('#interests-dirty')).toBeHidden();
  expect(posts).toBe(0);
  expect(errors).toEqual([]);
});
test('newer multiple-select edits survive a held real server response', async ({
  page,
}) => {
  const errors = await start(page);
  const release = await holdResponse(page, '**/counter/slowInterests');
  try {
    await page
      .getByRole('button', { name: 'Save interests slowly', exact: true })
      .click();
    await release.started;
    await page
      .getByLabel('Interests mirror', { exact: true })
      .selectOption(['build', 'review']);
    expect(await selected(page)).toEqual(['build', 'review']);
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(await selected(page)).toEqual(['build', 'review']);
  await expect(page.locator('#interests-dirty')).toBeVisible();
  await page
    .getByRole('button', { name: 'Save interests', exact: true })
    .click();
  await expect(page.locator('#saved-interests')).toHaveText('build review');
  await expect(page.locator('#interests-dirty')).toBeHidden();
  expect(errors).toEqual([]);
});
test('forged array items are rejected by the real server and another session cannot reuse state', async ({
  page,
  browser,
}) => {
  const errors = await start(page);
  const marker = await page.locator('[data-nv-component]').evaluate((root) => ({
    endpoint: root.getAttribute('data-nv-endpoint'),
    snapshot: root.getAttribute('data-nv-snapshot'),
    csrf: root.getAttribute('data-nv-csrf'),
    revision: Number(root.getAttribute('data-nv-revision')),
  }));
  if (!marker.endpoint || !marker.snapshot || !marker.csrf)
    throw new Error('Missing Live fixture');
  const payload = {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot: marker.snapshot,
    revision: marker.revision,
    updates: { interests: ['admin'] },
    input: null,
  };
  const headers = {
    origin: 'http://127.0.0.1:3102',
    'x-nestvexa-csrf': marker.csrf,
  };
  const rejected = await page.request.post(marker.endpoint + '/saveInterests', {
    headers,
    data: payload,
  });
  expect(rejected.status()).toBe(422);
  for (const interests of [
    ['design', 'design'],
    [['design']],
    Array.from({ length: 257 }, () => 'design'),
  ]) {
    expect(
      (
        await page.request.post(marker.endpoint + '/saveInterests', {
          headers,
          data: { ...payload, requestId: randomUUID(), updates: { interests } },
        })
      ).status(),
    ).toBe(422);
  }
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await other.goto('http://127.0.0.1:3102/');
    const otherCsrf = await other
      .locator('[data-nv-component]')
      .getAttribute('data-nv-csrf');
    if (!otherCsrf) throw new Error('Missing second session fixture');
    const stolen = await second.request.post(
      'http://127.0.0.1:3102' + marker.endpoint + '/saveInterests',
      {
        headers: { ...headers, 'x-nestvexa-csrf': otherCsrf },
        data: { ...payload, updates: { interests: ['build'] } },
      },
    );
    expect(stolen.status()).toBe(410);
  } finally {
    await second.close();
  }
  await page.getByLabel('Interests', { exact: true }).selectOption(['build']);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(errors).toEqual([]);
});
