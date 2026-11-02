import { expect, test } from '@playwright/test';

test('a third-party template engine renders an MVC page whose Live counter and model work in the browser', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3113/');
  await expect(page).toHaveTitle('Custom engine <tokens>');
  await expect(page.locator('h1')).toHaveText('Custom engine <tokens>');
  const counter = page.locator('[data-nv-name="counter"]');
  await expect(counter.locator('output')).toHaveText('0');
  await counter.getByRole('button', { name: 'Increment' }).click();
  await expect(counter.locator('output')).toHaveText('1');
  await counter.getByRole('button', { name: 'Increment' }).click();
  await expect(counter.locator('output')).toHaveText('2');
  const hostile = '<img src=x onerror=alert(1)>';
  await counter.getByLabel('Note').fill(hostile);
  // The custom engine escapes the synchronized value; no element is injected.
  await expect(counter.locator('span')).toHaveText(hostile);
  await expect(counter.locator('span img')).toHaveCount(0);
  await expect(counter.locator('output')).toHaveText('2');
  expect(errors).toEqual([]);
});
