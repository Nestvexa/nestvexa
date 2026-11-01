import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const url = 'http://127.0.0.1:3102/activity';
async function expectOrder(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator('#activity-tasks > li')
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute('nv:sort.item')),
        ),
    )
    .toEqual(ids);
}
test('keyboard sorting uses a validated Live action and preserves the retained focused handle', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  const handle = page.getByRole('button', {
    name: 'Move Build accessible forms',
  });
  await expect(page.locator('#activity-task-heading')).toHaveCount(0);
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest()) documents.push(request.url());
  });
  await handle.focus();
  await handle.evaluate((element) =>
    Reflect.set(window, 'activityOriginalSortHandle', element),
  );
  await handle.press('Alt+End');
  await expectOrder(page, ['security', 'docs', 'forms']);
  await expect(page.locator('#activity-task-heading')).toHaveText(
    'Activity tasks',
  );
  await expect(page.locator('#activity-tasks')).toHaveAttribute(
    'aria-labelledby',
    'activity-task-heading',
  );
  await expect(handle).toHaveAttribute(
    'aria-labelledby',
    'activity-task-label-forms',
  );
  await expect(handle).toBeFocused();
  expect(
    await handle.evaluate(
      (element) =>
        Reflect.get(window, 'activityOriginalSortHandle') === element,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('status').filter({ hasText: 'Order updated' }),
  ).toHaveText('Order updated for Activity tasks.');
  await handle.press('Alt+Home');
  await expectOrder(page, ['forms', 'security', 'docs']);
  await expect(handle).toBeFocused();
  expect(documents).toEqual([]);
  expect(errors).toEqual([]);
});

test('native pointer sorting commits server-rendered order and remains accessible', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Move Build accessible forms' }),
  ).toHaveAttribute('draggable', 'true');
  const last = page.locator('#activity-tasks > li').last();
  const bounds = await last.boundingBox();
  if (!bounds) throw new Error('Missing task geometry');
  await page
    .getByRole('button', { name: 'Move Build accessible forms' })
    .dragTo(last, {
      targetPosition: { x: bounds.width / 2, y: bounds.height - 2 },
    });
  await expectOrder(page, ['security', 'docs', 'forms']);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('forged orders and mass assignment fail without consuming the valid revision', async ({
  page,
  context,
}) => {
  await page.goto(url);
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  const markers = await page
    .locator('[data-nv-name=activity-panel]')
    .evaluate((element) => ({
      endpoint: element.getAttribute('data-nv-endpoint'),
      csrf: element.getAttribute('data-nv-csrf'),
      snapshot: element.getAttribute('data-nv-snapshot'),
      revision: Number(element.getAttribute('data-nv-revision')),
    }));
  for (const input of [
    { ids: ['forms', 'forms', 'docs'] },
    { ids: ['forms', 'security', 'foreign'] },
    { ids: ['forms', 'security', 'docs'], admin: true },
    { ids: ['__proto__'] },
  ]) {
    const result = await context.request.post(
      `http://127.0.0.1:3102${markers.endpoint}/reorder`,
      {
        headers: {
          origin: 'http://127.0.0.1:3102',
          'x-nestvexa-csrf': markers.csrf ?? '',
        },
        data: {
          protocol: 'nestvexa-live/1',
          requestId: 'forged-order',
          snapshot: markers.snapshot,
          revision: markers.revision,
          updates: {},
          input,
        },
      },
    );
    expect(result.status()).toBe(400);
  }
  await page
    .getByRole('button', { name: 'Move Build accessible forms' })
    .press('Alt+End');
  await expectOrder(page, ['security', 'docs', 'forms']);
});
