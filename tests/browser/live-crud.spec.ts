import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// examples/live-crud: a Live task board with search, filters, sorting,
// pagination, a validated create/edit modal (child component), confirmed
// delete and an optimistic toggle with rollback. Data is per guest session,
// so every test starts from the same seeded list.
const base = exampleUrl('live-crud', 3115);
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function open(page: Page, path = '/tasks'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  await expect(page.locator('[data-nv-name="task-board"]')).toBeVisible();
  return errors;
}
function titles(page: Page): Promise<string[]> {
  return page
    .locator('#task-list [id^="task-title-"]')
    .evaluateAll((items) =>
      items.map((item) => item.textContent?.trim() ?? ''),
    );
}
function row(page: Page, title: string) {
  return page.locator('#task-list article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}
async function markSameDocument(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
}
async function sameDocument(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(window, 'nvSameDocument'));
}

test('searches, filters, sorts and paginates on the server without a full reload', async ({
  page,
}) => {
  const errors = await open(page);
  await markSameDocument(page);
  await expect(page.locator('#task-counts')).toHaveText(
    '12 tasks: 9 open, 3 done',
  );
  expect(await titles(page)).toEqual([
    'Fix the flaky export job',
    'Write the incident review',
    'Draft the release notes',
    'Review the onboarding flow',
    'Rotate staging credentials',
  ]);
  await expect(page.locator('#task-summary')).toContainText('of 12');

  // Debounced live search over title and assignee; the URL follows.
  await page.getByLabel('Search title or assignee').fill('ada');
  await expect(page.locator('#task-list article')).toHaveCount(3);
  await expect(page).toHaveURL(/q=ada/);
  await page.getByLabel('Search title or assignee').fill('');
  await expect(page.locator('#task-list article')).toHaveCount(5);

  // Filters reset to page 1 and combine.
  await page.getByLabel('Status').selectOption('done');
  await expect(page.locator('#task-list article')).toHaveCount(3);
  await expect(page).toHaveURL(/status=done/);
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await expect(page.locator('#task-list article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('#task-list article')).toHaveCount(5);
  await page.getByLabel('Priority', { exact: true }).selectOption('low');
  await page.getByLabel('Status').selectOption('open');
  await expect(page.locator('#task-list article')).toHaveCount(2);
  expect(await titles(page)).toEqual([
    'Clean up feature flags',
    'Update the support macros',
  ]);
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // Sorting toggles direction and exposes the pressed state.
  const byTitle = page.getByRole('button', { name: 'Title', exact: true });
  await byTitle.click();
  await expect(page.locator('#task-sort')).toHaveText('title asc');
  await expect(byTitle).toHaveAttribute('aria-pressed', 'true');
  expect((await titles(page))[0]).toBe('Archive old invoices');
  await byTitle.click();
  await expect(page.locator('#task-sort')).toHaveText('title desc');
  expect((await titles(page))[0]).toBe('Write the incident review');
  await page.getByRole('button', { name: 'Priority', exact: true }).click();
  await expect(page.locator('#task-sort')).toHaveText('priority asc');
  await expect(page.locator('#task-list article')).toHaveCount(5);
  expect((await titles(page)).slice(0, 4)).toEqual([
    'Draft the release notes',
    'Fix the flaky export job',
    'Prepare the quarterly demo',
    'Rotate staging credentials',
  ]);
  await page.getByRole('button', { name: 'Due date', exact: true }).click();
  await expect(page.locator('#task-sort')).toHaveText('due asc');

  // Server-built page links navigate in place; Back restores the first page.
  await page.getByRole('link', { name: 'Page 3' }).click();
  await expect(page).toHaveURL(base + '/tasks?page=3');
  expect(await titles(page)).toEqual([
    'Archive old invoices',
    'Translate the help center',
  ]);
  await page.getByRole('link', { name: 'Previous page' }).click();
  await expect(page).toHaveURL(base + '/tasks?page=2');
  await expect(page.locator('#task-list article')).toHaveCount(5);
  await page.goBack();
  await expect(page).toHaveURL(base + '/tasks?page=3');
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('creates a task through the validated modal and returns focus', async ({
  page,
}) => {
  const errors = await open(page);
  await markSameDocument(page);
  const opener = page.getByRole('button', { name: 'New task' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  // Keyboard focus stays inside the modal dialog.
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Title')).toBeFocused();

  // Server validation: summary, inline messages, aria-invalid, focus.
  await dialog.getByLabel('Due date (YYYY-MM-DD, optional)').fill('2026-02-30');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('#task-error-summary')).toContainText(
    'There are 2 problems',
  );
  await expect(page.locator('#task-title-error')).toHaveText(
    'Enter at least 3 characters.',
  );
  await expect(page.locator('#task-due-error')).toHaveText(
    'Enter a real date as YYYY-MM-DD, or leave it empty.',
  );
  await expect(dialog.getByLabel('Title')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await expect(page.locator('#task-counts')).toHaveText(
    '12 tasks: 9 open, 3 done',
  );

  const hostile = 'Ship <img src=x onerror=alert(1)> safely';
  await dialog.getByLabel('Title').fill(hostile);
  await dialog.getByLabel('Assignee').fill('Grace');
  await dialog.getByLabel('Priority').selectOption('high');
  await dialog.getByLabel('Due date (YYYY-MM-DD, optional)').fill('2026-11-01');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#task-notice')).toHaveText(
    `Created “${hostile}”.`,
  );
  await expect(page.locator('#task-counts')).toHaveText(
    '13 tasks: 10 open, 3 done',
  );
  await expect(opener).toBeFocused();
  // Earliest due date: first row, rendered as text.
  expect((await titles(page))[0]).toBe(hostile);
  await expect(page.locator('#task-list img')).toHaveCount(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('edits a task in the modal; Escape cancels and restores focus', async ({
  page,
}) => {
  await open(page);
  const target = row(page, 'Draft the release notes');
  const edit = target.getByRole('button', {
    name: 'Edit Draft the release notes',
  });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Edit task' });
  await expect(dialog.getByLabel('Title')).toHaveValue(
    'Draft the release notes',
  );
  await expect(dialog.getByLabel('Assignee')).toHaveValue('Ada');
  await expect(dialog.getByLabel('Priority')).toHaveValue('high');
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await dialog.getByLabel('Title').fill('Changed but cancelled');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(row(page, 'Draft the release notes')).toHaveCount(1);

  await edit.click();
  await expect(dialog.getByLabel('Title')).toHaveValue(
    'Draft the release notes',
  );
  await dialog.getByLabel('Title').fill('Publish the release notes');
  await dialog.getByLabel('Assignee').fill('');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#task-notice')).toHaveText(
    'Saved “Publish the release notes”.',
  );
  const renamed = row(page, 'Publish the release notes');
  await expect(renamed).toContainText('Unassigned');
  await expect(row(page, 'Draft the release notes')).toHaveCount(0);
});

test('deletes only after confirmation', async ({ page }) => {
  await open(page);
  const remove = page.getByRole('button', {
    name: 'Delete Write the incident review',
  });
  // One persistent handler: dismiss the first prompt, accept the second.
  const prompts: string[] = [];
  const decisions = ['dismiss', 'accept'];
  page.on('dialog', (dialog) => {
    prompts.push(dialog.message());
    void (decisions.shift() === 'accept' ? dialog.accept() : dialog.dismiss());
  });
  await remove.click();
  await expect
    .poll(() => prompts)
    .toEqual(['Delete “Write the incident review”?']);
  await expect(row(page, 'Write the incident review')).toHaveCount(1);
  await remove.click();
  await expect.poll(() => prompts.length).toBe(2);
  await expect(page.locator('#task-notice')).toHaveText('Task deleted.');
  await expect(row(page, 'Write the incident review')).toHaveCount(0);
  await expect(page.locator('#task-counts')).toHaveText(
    '11 tasks: 8 open, 3 done',
  );
});

test('the done toggle is optimistic and rolls back when the server refuses', async ({
  page,
}) => {
  await open(page);
  const target = row(page, 'Review the onboarding flow');
  const done = target.locator('output');
  const toggle = target.getByRole('button', {
    name: 'Toggle done for Review the onboarding flow',
  });
  await expect(done).toHaveText('false');
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/_nestvexa/live/task-row/toggleDone', async (route) => {
    await held;
    await route.continue();
  });
  await toggle.click();
  // Projected before the server answers.
  await expect(done).toHaveText('true');
  release();
  await expect(page.locator('#task-counts')).toHaveText(
    '12 tasks: 8 open, 4 done',
  );
  await expect(done).toHaveText('true');
  await page.unroute('**/_nestvexa/live/task-row/toggleDone');

  await page.route('**/_nestvexa/live/task-row/toggleDone', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"statusCode":403,"code":"ACTION_FORBIDDEN"}',
    }),
  );
  const rollback = page.evaluate(
    () =>
      new Promise<unknown>((resolve) =>
        document.addEventListener(
          'nestvexa:rollback',
          (event) => resolve((event as CustomEvent).detail),
          { once: true },
        ),
      ),
  );
  await toggle.click();
  expect(await rollback).toMatchObject({
    action: 'toggleDone',
    fields: ['done'],
  });
  await expect(done).toHaveText('true');
  await expect(page.locator('#task-counts')).toHaveText(
    '12 tasks: 8 open, 4 done',
  );
});

test('tasks are per session and forged events or state are refused', async ({
  page,
  browser,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill('Only in my session');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('#task-notice')).toContainText(
    'Only in my session',
  );

  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    await stranger.goto(base + '/tasks?q=Only');
    await expect(stranger.locator('#task-empty')).toBeVisible();
    const json = (await (
      await stranger.request.get(base + '/api/tasks')
    ).json()) as {
      title: string;
    }[];
    expect(json.map((task) => task.title)).not.toContain('Only in my session');
  } finally {
    await other.close();
  }

  const board = page.locator('[data-nv-name="task-board"]');
  const snapshot = (await board.getAttribute('data-nv-snapshot')) ?? '';
  const csrf = (await board.getAttribute('data-nv-csrf')) ?? '';
  const revision = Number(await board.getAttribute('data-nv-revision'));
  const headers = {
    origin: base,
    'content-type': 'application/json',
    'x-nestvexa-csrf': csrf,
  };
  const payload = (updates: object, input: unknown = null) => ({
    protocol: 'nestvexa-live/1',
    requestId: crypto.randomUUID(),
    snapshot,
    revision,
    updates,
    input,
  });
  // Event listeners are ordinary actions: payloads go through strict pipes.
  const malformed = await page.request.post(
    `${base}/_nestvexa/live/task-board/saved`,
    { headers, data: payload({}, { id: 't1', extra: true }) },
  );
  expect(malformed.status()).toBe(400);
  // Writable state keeps its validator.
  const invalidState = await page.request.post(
    `${base}/_nestvexa/live/task-board/_sync`,
    { headers, data: payload({ status: 'everything' }) },
  );
  expect(invalidState.status()).toBe(422);
  // Server-only state cannot be written from the browser.
  const locked = await page.request.post(
    `${base}/_nestvexa/live/task-board/_sync`,
    { headers, data: payload({ editing: 'new' }) },
  );
  expect(locked.status()).toBe(422);
  // Actions outside the host allowlist are refused.
  const unlisted = await page.request.post(
    `${base}/_nestvexa/live/task-board/afterUpdate`,
    { headers, data: payload({}) },
  );
  expect(unlisted.status()).toBeGreaterThanOrEqual(400);
  expect(unlisted.status()).toBeLessThan(500);
});

test('accessibility: board, open modal and validation errors have no axe violations', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
  await page.getByRole('button', { name: 'New task' }).click();
  await page
    .getByRole('dialog', { name: 'New task' })
    .getByRole('button', { name: 'Create task' })
    .click();
  await expect(page.locator('#task-error-summary')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
});
