import { expect, test } from '@playwright/test';

test('the default HBS client reads an authorized text stream without executing embedded markup', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3102/activity?q=public');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await page.getByRole('button', { name: 'Read activity summary' }).click();
  await expect(page.locator('#activity-stream-status')).toHaveText(
    'Summary complete',
  );
  await expect(page.locator('#activity-summary')).toHaveText(
    'Activity query: public\nPublic demonstration summary — مرحباً\n<script>This is literal text, never HTML.</script>',
  );
  await expect(page.locator('#activity-summary script')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle activity detail' }).click();
  await page.getByRole('button', { name: 'Read activity summary' }).click();
  await expect(page.locator('#activity-stream-status')).toHaveText(
    'Summary complete',
  );
  expect(errors).toEqual([]);
});

test('cancelling a stream permits an explicit fresh read', async ({ page }) => {
  await page.goto('http://127.0.0.1:3102/activity');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await page.getByRole('button', { name: 'Read activity summary' }).click();
  await page.getByRole('button', { name: 'Cancel summary' }).click();
  await expect(
    page.getByRole('button', { name: 'Read activity summary' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Read activity summary' }).click();
  await expect(page.locator('#activity-stream-status')).toHaveText(
    'Summary complete',
  );
});
