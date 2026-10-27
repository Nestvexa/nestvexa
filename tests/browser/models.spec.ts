import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('live debounce and blur synchronization do not invoke actions or reload', async ({
  page,
}) => {
  await page.goto('/');
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request.url());
  });
  const search = page.getByLabel('Live search');
  await search.focus();
  await search.evaluate((element) => {
    for (const value of ['one', 'two', 'final']) {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  });
  await expect(page.locator('#search-server')).toHaveText('final');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/counter/_sync');
  await expect(page.locator('#count')).toHaveText('0');
  await expect(search).toBeFocused();
  const nickname = page.getByLabel('Blur nickname');
  await nickname.fill('on blur');
  await expect(page.locator('#nickname-server')).toHaveText('');
  await search.focus();
  await expect(page.locator('#nickname-server')).toHaveText('on blur');
});

test('number, boolean select and radio models synchronize through native events', async ({
  page,
}) => {
  await page.goto('/');
  const quantity = page.getByLabel('Quantity');
  await quantity.fill('12.5');
  await quantity.press('Tab');
  await expect(page.locator('#quantity-server')).toHaveText('12.5');
  await page.getByLabel('Enabled', { exact: true }).selectOption('true');
  await expect(page.locator('#enabled-server')).toHaveText('true');
  await page.getByLabel('Blue', { exact: true }).check();
  await expect(page.locator('#color-server')).toHaveText('blue');
  await expect(page.getByLabel('Blue', { exact: true })).toBeChecked();
});

test('invalid cast blocks stale submission and server validation recovers with the same snapshot', async ({
  page,
}) => {
  await page.goto('/');
  const quantity = page.getByLabel('Quantity');
  await quantity.fill('invalid');
  await quantity.press('Tab');
  await expect(page.locator('#status')).toContainText('finite decimal');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Correct invalid');
  await expect(page.locator('#count')).toHaveText('0');
  await quantity.fill('3');
  await quantity.press('Tab');
  await expect(page.locator('#quantity-server')).toHaveText('3');
  const search = page.getByLabel('Live search');
  const snapshot = await page
    .locator('[data-nv-component]')
    .getAttribute('data-nv-snapshot');
  await search.fill('x'.repeat(31));
  await expect(page.locator('#status')).toContainText('422');
  expect(
    await page.locator('[data-nv-component]').getAttribute('data-nv-snapshot'),
  ).toBe(snapshot);
  await search.fill('recovered');
  await expect(page.locator('#search-server')).toHaveText('recovered');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
});

test('composition defers live sync and newer edited values survive an in-flight morph', async ({
  page,
}) => {
  await page.goto('/');
  const search = page.getByLabel('Live search');
  await search.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    (element as HTMLInputElement).value = 'مرحبا';
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, isComposing: true }),
    );
  });
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '0',
  );
  await search.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  );
  await expect(page.locator('#search-server')).toHaveText('مرحبا');
  const releaseEdit = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Slow increase', exact: true })
      .click();
    await search.fill('latest edit');
  } finally {
    releaseEdit();
  }
  await expect(page.locator('#count')).toHaveText('1');
  await expect(search).toHaveValue('latest edit');
  await expect(page.locator('#search-server')).toHaveText('latest edit');
  const releaseComposition = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Slow increase', exact: true })
      .click();
    await search.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
      (element as HTMLInputElement).value = '入力中';
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, isComposing: true }),
      );
    });
  } finally {
    releaseComposition();
  }
  await expect(page.locator('#count')).toHaveText('2');
  await expect(search).toHaveValue('入力中');
  await search.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  );
  await expect(page.locator('#search-server')).toHaveText('入力中');
});
