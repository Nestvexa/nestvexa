import { test, expect } from '@playwright/test';

test('real MVC navigation and escaped script content', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.doctype?.name)).toBe('html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nestvexa');
  await expect(page.locator('pre')).toContainText('<script>');
  expect(await page.locator('script').count()).toBe(0);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveTitle('About Nestvexa');
  await page.goBack();
  await expect(page).toHaveTitle('Nestvexa');
});

test('accessibility: landmarks and keyboard navigation work without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3100');
  await page.bringToFront();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
  const nextLink = 'Tab';
  await page.keyboard.press(nextLink);
  await expect(
    page.getByRole('link', { name: 'Nestvexa', exact: true }),
  ).toBeFocused();
  await page.keyboard.press(nextLink);
  await page.keyboard.press('Enter');
  await expect(page).toHaveTitle('About Nestvexa');
  await context.close();
});
