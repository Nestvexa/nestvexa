import { expect, test } from '@playwright/test';

test('Phase 4 update hooks run on accepted model synchronization and form fields before rendering', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3102/board');
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('#board-last-updated')).toHaveText('None');
  const search = page.getByRole('textbox', { name: 'Search work items' });
  await search.fill('security');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('#board-last-updated')).toHaveText('query');
  const title = page.getByRole('textbox', { name: 'New work item' });
  await title.fill('A lifecycle example');
  await title.press('Enter');
  await expect(page.locator('#board-status')).toHaveText('Work item added');
  await expect(page.locator('#board-last-updated')).toHaveText('title');
  await expect(title).toHaveValue('');
  await search.fill('');
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(page.locator('#board-last-updated')).toHaveText('query');
  expect(errors).toEqual([]);
});
