import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const base = 'http://127.0.0.1:3102';
async function open(page: Page, path = '/projects') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  await expect(page.locator('#project-list > li')).toHaveCount(4);
  return errors;
}
function names(page: Page) {
  return page
    .locator('#project-list [id^="project-name-"]')
    .evaluateAll((items) => items.map((item) => item.textContent?.trim()));
}

test('Live CRUD board searches, sorts, paginates, validates and creates through real Nest routes', async ({
  page,
}) => {
  const errors = await open(page);
  expect(await names(page)).toEqual(['Atlas', 'Beacon', 'Cobalt', 'Delta']);
  await expect(page.locator('#project-summary')).toContainText('of 7');

  // Live search with debounced synchronization updates the URL query.
  await page.locator('#project-search').fill('o');
  await expect(page.locator('#project-list > li')).toHaveCount(3);
  expect(await names(page)).toEqual(['Beacon', 'Cobalt', 'Fjord']);
  await expect(page).toHaveURL(/q=o/);
  await page.locator('#project-search').fill('');
  await expect(page.locator('#project-list > li')).toHaveCount(4);

  // Server-authoritative sorting.
  await page.getByRole('button', { name: 'By status' }).click();
  await expect(page.locator('#project-sort')).toHaveText('status');
  expect((await names(page))[0]).toBe('Beacon');
  await page.getByRole('button', { name: 'By name' }).click();
  await expect(page.locator('#project-sort')).toHaveText('name');

  // Server validation errors are announced next to the field.
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#project-name-error')).toHaveText(
    'Enter at least 2 characters.',
  );
  await expect(page.locator('#project-name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.locator('#project-name').fill('Atlas');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#project-name-error')).toHaveText(
    'A project with this name already exists.',
  );
  await page.locator('#project-name').fill('Aurora <script>x</script>');
  await page.locator('#project-status').selectOption('active');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#project-toast')).toHaveText(
    'Aurora <script>x</script> was created',
  );
  await expect(page.locator('#project-name-error')).toHaveCount(0);
  await expect(page.locator('#project-summary')).toContainText('of 8');
  expect((await names(page))[1]).toBe('Aurora <script>x</script>');
  await expect(page.locator('#project-list script')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('pagination links navigate without a full reload and Back restores the previous page', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  await page.getByRole('link', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(base + '/projects?page=2');
  await expect(page.locator('#project-list > li')).toHaveCount(3);
  expect(await names(page)).toEqual(['Ember', 'Fjord', 'Granite']);
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  // The swapped page's components are live.
  await page.getByRole('button', { name: 'Star Fjord' }).click();
  await expect(page.locator('#project-starred-fjord')).toHaveText('true');
  await page.goBack();
  await expect(page).toHaveURL(base + '/projects');
  await expect(page.locator('#project-list > li')).toHaveCount(4);
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  await page.getByRole('button', { name: 'By status' }).click();
  await expect(page.locator('#project-sort')).toHaveText('status');
});

test('optimistic star shows immediately and rolls back when the server rejects', async ({
  page,
}) => {
  await open(page);
  // Hold the request so the optimistic projection is observable.
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(
    '**/_nestvexa/live/project-row/toggleStar',
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.getByRole('button', { name: 'Star Atlas' }).click();
  await expect(page.locator('#project-starred-atlas')).toHaveText('true');
  release();
  await expect(page.locator('#project-starred-atlas')).toHaveText('true');
  await page.unroute('**/_nestvexa/live/project-row/toggleStar');

  // A rejected request restores the authoritative value and emits rollback.
  await page.route('**/_nestvexa/live/project-row/toggleStar', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"statusCode":403,"code":"ACTION_FORBIDDEN"}',
    }),
  );
  await page.evaluate(() => {
    Reflect.set(window, 'nvRollbacks', []);
    document.addEventListener('nestvexa:rollback', (event) => {
      (Reflect.get(window, 'nvRollbacks') as unknown[]).push(
        (event as CustomEvent).detail,
      );
    });
  });
  await page.getByRole('button', { name: 'Star Atlas' }).click();
  await expect(page.locator('#project-starred-atlas')).toHaveText('true');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'nvRollbacks')))
    .toEqual([{ action: 'toggleStar', fields: ['starred'] }]);
});

test('delete confirms, removes the child row via an event and announces it', async ({
  page,
}) => {
  await open(page);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete Beacon' }).click();
  await expect(page.locator('#project-toast')).toHaveText('Beacon was deleted');
  await expect(page.locator('#project-summary')).toContainText('of 6');
  expect(await names(page)).toEqual(['Atlas', 'Cobalt', 'Delta', 'Ember']);
  // Dismissed confirmation sends nothing.
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: 'Delete Atlas' }).click();
  await expect(page.locator('#project-name-atlas')).toBeVisible();
});

test('CSV export downloads a single-use attachment and archive redirects with a flash message', async ({
  page,
}) => {
  await open(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('projects.csv');
  const path = await file.path();
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(path, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('"name","status","starred"');
  expect(csv).toContain('"Atlas","planned","false"');
  // The token is consumed.
  const replay = await page.request.get(file.url());
  expect(replay.status()).toBe(404);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archive completed' }).click();
  await expect(page.locator('#flash')).toHaveText(
    'Archived 2 completed projects.',
  );
  await expect(page.locator('#project-summary')).toContainText('of 5');
  await page.reload();
  await expect(page.locator('#flash')).toHaveCount(0);
});

test('accessibility: projects board passes automated checks including validation state', async ({
  page,
}) => {
  await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#project-name-error')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('projects pagination works without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(base + '/projects');
  await page.getByRole('link', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(base + '/projects?page=2');
  await expect(page.locator('#project-list > li')).toHaveCount(3);
  await context.close();
});
