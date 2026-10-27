import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('focused input type changes keep the live revision usable without an invalid caret restore', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const field = page.getByLabel('Changing input type');
  await field.focus();
  await field.evaluate((element) =>
    (element as HTMLInputElement).setSelectionRange(0, 2),
  );
  await field.press('Enter');
  await expect(field).toHaveAttribute('type', 'number');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await field.press('Enter');
  await expect(field).toHaveAttribute('type', 'text');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '2',
  );
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#status')).toHaveText('Updated');
  expect(errors).toEqual([]);
});

test('loading targets track queued actions independently and retain server-disabled state', async ({
  page,
}) => {
  await page.goto('/');
  const slow = page.getByRole('button', { name: 'Slow increase', exact: true });
  const serverDisabled = page.locator('#server-disabled');
  await expect(slow).toBeEnabled();
  await expect(serverDisabled).toBeDisabled();
  const releaseSlow = await holdResponse(page, '**/counter/slow');
  const releaseIncrement = await holdResponse(page, '**/counter/increment');
  try {
    await slow.click();
    await expect(slow).toBeDisabled();
    await expect(page.locator('#loading-style')).toHaveClass(
      'baseline working',
    );
    await expect(page.locator('#idle-status')).toBeHidden();
    await expect(page.locator('#increment-style')).not.toHaveClass('queued');
    await page.getByRole('button', { name: 'Increase', exact: true }).click();
    await expect(page.locator('#increment-style')).toHaveClass('queued');
    releaseSlow();
    await expect(page.locator('#count')).toHaveText('1');
    await expect(slow).toBeEnabled();
    await expect(page.locator('#loading-style')).toHaveClass('baseline');
    await expect(page.locator('#idle-status')).toBeVisible();
    await expect(page.locator('#increment-style')).toHaveClass('queued');
    await expect(serverDisabled).toBeDisabled();
  } finally {
    releaseSlow();
    releaseIncrement();
  }
  await expect(page.locator('#count')).toHaveText('2');
  await expect(page.locator('#increment-style')).not.toHaveClass('queued');
  await expect(serverDisabled).toBeDisabled();
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});

test('replacement resets DOM objects, focuses the component and initializes inserted actions once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('#replace-children').evaluate((element) => {
    Reflect.set(window, 'nvReplacementWrapper', element);
  });
  await page.locator('#replace-self').evaluate((element) => {
    Reflect.set(window, 'nvReplacementSelf', element);
  });
  await page.getByLabel('Temporary replacement note').fill('local edit');
  const replaceButton = page.getByRole('button', {
    name: 'Replace children increase',
  });
  await replaceButton.focus();
  await replaceButton.press('Enter');
  await expect(page.locator('#count')).toHaveText('1');
  expect(
    await page.locator('#replace-children').evaluate((element) => {
      const original: unknown = Reflect.get(window, 'nvReplacementWrapper');
      return element === original;
    }),
  ).toBe(true);
  expect(
    await page.locator('#replace-self').evaluate((element) => {
      const original: unknown = Reflect.get(window, 'nvReplacementSelf');
      return element === original;
    }),
  ).toBe(false);
  await expect(page.getByLabel('Temporary replacement note')).toHaveValue(
    'Server default',
  );
  await expect(page.locator('[data-nv-component]')).toBeFocused();
  await page.getByRole('button', { name: 'Replace element increase' }).click();
  await expect(page.locator('#count')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('replacement disposes an Alpine subtree and mounts a new widget once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Replacement Alpine click', exact: true })
    .click();
  await expect(page.locator('#replacement-alpine-local')).toHaveText('1');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#replacement-alpine-local')).toHaveText('0');
  await page
    .getByRole('button', { name: 'Replacement Alpine click', exact: true })
    .click();
  await expect(page.locator('#replacement-alpine-local')).toHaveText('1');
  expect(errors).toEqual([]);
});
