import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('native reset clears hidden deferred edits before a real action', async ({
  page,
}) => {
  await page.goto('/');
  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      const body: unknown = request.postDataJSON();
      if (body && typeof body === 'object')
        updates.push(Reflect.get(body, 'updates'));
    }
  });
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Discard this draft');
  await expect(page.locator('#dirty-name')).toBeVisible();
  await page
    .getByRole('button', { name: 'Reset display draft', exact: true })
    .click();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    '',
  );
  await expect(page.locator('#name-preview')).toHaveText('');
  await expect(page.locator('#dirty-name')).toBeHidden();
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await expect(page.locator('#saved')).toHaveText('');
  expect(updates).toEqual([{ name: '' }]);
});

test('reset cancels model synchronization while a canceled reset leaves its draft intact', async ({
  page,
}) => {
  await page.goto('/');
  await page.clock.install();
  await page.getByLabel('Live search').evaluate((element) => {
    if (!(element instanceof HTMLInputElement) || !element.form)
      throw new Error('Missing model form');
    element.value = 'Discard queued search';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.form.reset();
  });
  await page.clock.runFor(1000);
  await expect(page.getByLabel('Live search')).toHaveValue('');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '0',
  );
  await page.getByLabel('Live search').evaluate((element) => {
    if (!(element instanceof HTMLInputElement) || !element.form)
      throw new Error('Missing model form');
    document.addEventListener('reset', (event) => event.preventDefault(), {
      once: true,
    });
    element.value = 'Keep canceled reset';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.form.reset();
  });
  await expect(page.getByLabel('Live search')).toHaveValue(
    'Keep canceled reset',
  );
  await page.clock.runFor(1000);
  await expect(page.locator('#search-server')).toHaveText(
    'Keep canceled reset',
  );
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
});

test('reset during a pending action survives its response and the next action sends the reset value', async ({
  page,
}) => {
  await page.goto('/');
  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      const body: unknown = request.postDataJSON();
      if (body && typeof body === 'object')
        updates.push(Reflect.get(body, 'updates'));
    }
  });
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Sent before reset');
  const release = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Slow increase', exact: true })
      .click();
    await release.started;
    await page
      .getByRole('button', { name: 'Reset display draft', exact: true })
      .click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
      '',
    );
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    '',
  );
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '2',
  );
  await expect(page.locator('#saved')).toHaveText('');
  expect(updates).toEqual([{ name: 'Sent before reset' }, { name: '' }]);
});
