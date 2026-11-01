import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('nested children keep local DOM, refresh changed reactive props and handle child events', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3102/team');
  // The lazy child loads its body after the page boots.
  await expect(page.locator('#team-stats')).toHaveText(
    'Team statistics are ready',
  );
  await expect(page.locator('#team-stats-placeholder')).toHaveCount(0);

  // Browser-local drafts inside independent child roots.
  await page.locator('#member-note-ada').fill('Ada draft');
  await page.locator('#member-note-grace').fill('Grace draft');
  const adaCard = await page
    .locator('[data-nv-key="nv-child:member:ada"]')
    .elementHandle();
  const graceRevision = await page
    .locator('[data-nv-key="nv-child:member:grace"]')
    .getAttribute('data-nv-revision');
  expect(graceRevision).toBe('0');

  // A parent action changes only Grace's reactive name.
  await page.getByRole('button', { name: 'Rename Grace' }).click();
  await expect(page.locator('#member-name-grace')).toHaveText('Grace Hopper');
  await expect(
    page.locator('[data-nv-key="nv-child:member:grace"]'),
  ).toHaveAttribute('data-nv-revision', '1');
  // Ada's card is the same retained element with its local draft.
  expect(
    await page
      .locator('[data-nv-key="nv-child:member:ada"]')
      .evaluate((element, previous) => element === previous, adaCard),
  ).toBe(true);
  await expect(page.locator('#member-note-ada')).toHaveValue('Ada draft');

  // Child actions use the child's own route and do not re-render the parent.
  await page.getByRole('button', { name: 'Thank Ada' }).click();
  await expect(page.locator('#member-kudos-ada')).toHaveText('1');
  await expect(page.locator('#member-note-ada')).toHaveValue('Ada draft');

  // A child event is delivered to the parent's @OnEvent action.
  await page.getByRole('button', { name: 'Grace Hopper leaves' }).click();
  await expect(page.locator('#team-departures')).toHaveText('1');
  await expect(
    page.locator('[data-nv-key="nv-child:member:grace"]'),
  ).toHaveCount(0);
  await expect(page.locator('#member-note-ada')).toHaveValue('Ada draft');
  expect(errors).toEqual([]);
});

test('a modelable child proposes its value to the parent and parent updates flow down', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:3102/team');
  await expect(page.locator('#team-stats')).toBeVisible();
  await page.getByRole('button', { name: 'Make editor' }).click();
  await expect(page.locator('#picker-role')).toHaveText('editor');
  await expect(page.locator('#team-role')).toHaveText('editor');
  await page.getByRole('button', { name: 'Make owner' }).click();
  await expect(page.locator('#team-role')).toHaveText('owner');
});

test('a server redirect navigates to an application path after commit', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:3102/team');
  await expect(page.locator('#team-stats')).toBeVisible();
  await page.getByRole('button', { name: 'Finish and visit About' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3102/about');
});

test('accessibility: nested team board passes automated checks', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:3102/team');
  await expect(page.locator('#team-stats')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
