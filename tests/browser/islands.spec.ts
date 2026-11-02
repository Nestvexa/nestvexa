import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const url = 'http://127.0.0.1:3112/hybrid';
const log = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { nvIslandLog?: string[] }).nvIslandLog ?? [],
  );

test('React, Vue and Svelte islands mount independently and survive Live updates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/islands/'))
      scripts.push(new URL(request.url()).pathname);
  });
  await page.goto(url);
  await expect(page.locator('#chart-title')).toHaveText('Revenue by quarter');
  await page
    .locator('[data-nv-island="activity-feed"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Dashboard opened',
  );
  await expect(page.locator('#feed-items li').nth(1)).toHaveText(
    '<b>escaped</b> markup stays text',
  );
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  // Separate framework chunks were loaded lazily through the allowlist.
  expect(scripts.some((path) => /chunks\/react-chart-/.test(path))).toBe(true);
  expect(scripts.some((path) => /chunks\/vue-feed-/.test(path))).toBe(true);
  expect(scripts.some((path) => /chunks\/svelte-widget-/.test(path))).toBe(
    true,
  );

  // Local island state.
  await page.getByRole('button', { name: 'Quarter 2' }).click();
  await expect(page.locator('#chart-selected')).toHaveText(
    'Selected quarter 2',
  );
  await page.locator('#feed-draft').fill('local Vue draft');
  await page.getByRole('button', { name: 'Toggle status' }).click();
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  // The event bridge carried the React selection to the Vue feed.
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Chart quarter 2 selected',
  );

  // A Live update re-renders the component that owns the React island.
  await page.getByRole('button', { name: 'Add notification' }).click();
  await expect(page.locator('#notification-count')).toHaveText('1');
  await expect(page.locator('#chart-selected')).toHaveText(
    'Selected quarter 2',
  );
  await expect(page.locator('#feed-draft')).toHaveValue('local Vue draft');
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  expect(
    (await log(page)).filter((entry) => entry.endsWith(':mount')).sort(),
  ).toEqual([
    'activity-feed:mount',
    'revenue-chart:mount',
    'status-widget:mount',
  ]);
  expect(errors).toEqual([]);
});

test('removing and reinserting an island cleans up and remounts exactly once', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#chart-title')).toBeVisible();
  await page.getByRole('button', { name: 'Quarter 3' }).click();
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('[data-nv-island="revenue-chart"]')).toHaveCount(0);
  await expect.poll(() => log(page)).toContain('revenue-chart:unmount');
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('#chart-title')).toBeVisible();
  // A reinserted island is a fresh mount: previous local state is gone.
  await expect(page.locator('#chart-selected')).toHaveText(
    'No quarter selected',
  );
  // React effects run after paint; poll until the remount is recorded.
  await expect
    .poll(async () =>
      (await log(page)).filter((entry) => entry.startsWith('revenue-chart')),
    )
    .toEqual([
      'revenue-chart:mount',
      'revenue-chart:unmount',
      'revenue-chart:mount',
    ]);
  // Repeated scans never double-mount.
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nvIslands: { mounted: number } }).nvIslands
          .mounted,
    ),
  ).toBe(3);
});

test('a failing island keeps its fallback and does not affect others', async ({
  page,
}) => {
  await page.goto(url);
  const broken = page.locator('[data-nv-island="broken-island"]');
  await expect(broken).toHaveAttribute('data-nv-island-failed', '');
  await expect(broken).toHaveText(
    'This widget is unavailable; the page keeps working.',
  );
  await expect(page.locator('#chart-title')).toBeVisible();
});

test('accessibility: hybrid dashboard passes automated checks', async ({
  page,
}) => {
  // Three framework islands plus axe can exceed 30s in Firefox on loaded hosts.
  test.setTimeout(60_000);
  await page.goto(url);
  await expect(page.locator('#chart-title')).toBeVisible();
  await page
    .locator('[data-nv-island="status-widget"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#widget-status')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
