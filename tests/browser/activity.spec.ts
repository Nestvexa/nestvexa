import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = 'http://127.0.0.1:3102';

test('public URL state, session state, owned observers and current links work through real Live routes', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/activity?q=first&other=kept');
  const root = page.locator('[data-nv-name=activity-panel]');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await expect(page.locator('#activity-query')).toHaveText('first');
  await expect(page.locator('#activity-link')).toHaveClass('active');
  await page
    .getByRole('textbox', { name: 'Activity query' })
    .fill('second & <value>');
  await page.getByRole('button', { name: 'Remember activity view' }).click();
  await expect(page.locator('#activity-remembered')).toHaveText('1');
  await expect(page.locator('#activity-query')).toHaveText('second & <value>');
  await expect(page).toHaveURL(/q=second\+%26\+%3Cvalue%3E&other=kept$/);
  await expect(root).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expect(page.locator('#activity-remembered')).toHaveText('1');
  await expect(page.locator('#activity-query')).toHaveText('second & <value>');
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    await guest.goto(base + '/activity');
    await expect(guest.locator('#activity-remembered')).toHaveText('0');
    await expect(guest.locator('#activity-query')).toHaveText('');
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});

test('URL history returns through the guarded document route without replaying mutations', async ({
  page,
}) => {
  await page.goto(base + '/activity?q=first');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await page.getByRole('textbox', { name: 'Activity query' }).fill('second');
  await page.getByRole('button', { name: 'Remember activity view' }).click();
  await expect(page.locator('#activity-remembered')).toHaveText('1');
  await expect(page).toHaveURL(base + '/activity?q=second');
  await page.goBack();
  await expect(page).toHaveURL(base + '/activity?q=first');
  await expect(page.locator('#activity-query')).toHaveText('first');
  await expect(page.locator('#activity-remembered')).toHaveText('1');
});

test('polling pauses when offline and resumes a single protected refresh after reconnect', async ({
  page,
  context,
}) => {
  await page.goto(base + '/activity');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  // Reconfigure a documented minimum interval; the real runtime reconciles it.
  await page.locator('[nv\\:poll\\.30s]').evaluate((element) => {
    element.removeAttribute('nv:poll.30s');
    element.setAttribute('nv:poll.1s', 'refresh');
  });
  await context.setOffline(true);
  await expect(page.locator('[nv\\:offline]')).toBeVisible();
  await page.clock.runFor(5000);
  await expect(page.locator('#activity-refreshes')).toHaveText('0');
  await context.setOffline(false);
  await expect(page.locator('[nv\\:offline]')).toBeHidden();
  await page.clock.runFor(1100);
  await expect(page.locator('#activity-refreshes')).toHaveText('1');
});

test('visibility transitions preserve accessible state and cancel under reduced motion', async ({
  page,
}) => {
  await page.goto(base + '/activity');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  const detail = page
    .getByText('Each browser session keeps', { exact: false })
    .locator('..');
  await page.getByRole('button', { name: 'Toggle activity detail' }).click();
  await expect(detail).toHaveAttribute('aria-hidden', 'true');
  await expect(detail).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Toggle activity detail' }).click();
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute('aria-hidden', 'false');
});

test('activity state and connectivity indicators pass automated accessibility checks', async ({
  page,
}) => {
  await page.goto(base + '/activity?q=accessible');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('activity filtering has a real GET fallback without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(base + '/activity');
    await expect(page.locator('[nv\\:offline]')).toBeHidden();
    await page
      .getByRole('textbox', { name: 'Activity query' })
      .fill('plain form');
    await page.getByRole('button', { name: 'Remember activity view' }).click();
    await expect(page).toHaveURL(base + '/activity?q=plain+form');
    await expect(page.locator('#activity-query')).toHaveText('plain form');
    await expect(page.locator('#activity-remembered')).toHaveText('0');
    await expect(page.locator('#activity-appearances')).toHaveText('0');
  } finally {
    await context.close();
  }
});
