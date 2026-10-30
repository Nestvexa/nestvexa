import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { holdResponse } from './transport.js';
import { randomUUID } from 'node:crypto';

const board = 'http://127.0.0.1:3102/board';

test('Phase 3 board visual round trip preserves layout after keyed reordering', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(board);
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const initial = await page
    .locator('main')
    .screenshot({ animations: 'disabled' });
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('#board-order')).toHaveText('descending');
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('#board-order')).toHaveText('ascending');
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  const restored = await page
    .locator('main')
    .screenshot({ animations: 'disabled' });
  await testInfo.attach('initial-board', {
    body: initial,
    contentType: 'image/png',
  });
  await testInfo.attach('restored-board', {
    body: restored,
    contentType: 'image/png',
  });
  expect(restored.equals(initial)).toBe(true);
});

test('Phase 3 board rejects forged locked state, invalid types and oversized input without consuming its revision', async ({
  page,
}) => {
  await page.goto(board);
  const marker = await page
    .locator('[data-nv-name=work-board]')
    .evaluate((root) => ({
      endpoint: root.getAttribute('data-nv-endpoint'),
      snapshot: root.getAttribute('data-nv-snapshot'),
      csrf: root.getAttribute('data-nv-csrf'),
    }));
  if (!marker.endpoint || !marker.snapshot || !marker.csrf)
    throw new Error('Missing board marker');
  for (const updates of [
    { rows: [] },
    { title: 42 },
    { query: 'x'.repeat(81) },
  ]) {
    const response = await page.request.post(
      new URL(marker.endpoint + '/add', board).href,
      {
        headers: {
          origin: 'http://127.0.0.1:3102',
          'x-nestvexa-csrf': marker.csrf,
        },
        data: {
          protocol: 'nestvexa-live/1',
          requestId: randomUUID(),
          snapshot: marker.snapshot,
          revision: 0,
          updates,
          input: null,
        },
      },
    );
    expect(response.status()).toBe(422);
  }
  await page
    .getByRole('textbox', { name: 'New work item' })
    .fill('A valid correction');
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
});

test('Phase 3 nested DOM ownership retains independently authorized real components across parent and child mutations', async ({
  page,
}) => {
  await page.goto(board + '/ownership');
  // Explicit host composition fixture: both roots were mounted by Nest. This is
  // DOM ownership coverage, not the Phase 4 server parent/child lifecycle API.
  await page
    .locator('[data-nv-name=counter]')
    .evaluate((child) => document.getElementById('board-child')?.append(child));
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Nested draft');
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('#board-order')).toHaveText('descending');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(
    page.getByRole('textbox', { name: 'Name', exact: true }),
  ).toHaveValue('Nested draft');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText('Nested draft');
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await expect(page.locator('[data-nv-name=counter]')).toHaveAttribute(
    'data-nv-revision',
    '2',
  );
});

test('Phase 3 HBS board searches, sorts and validates a keyboard-submitted form under CSP', async ({
  page,
}) => {
  const errors: string[] = [];
  const documents: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents.push(request.url());
  });
  const response = await page.goto(board);
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self'",
  );
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('[nv\\:cloak]')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const search = page.getByRole('textbox', { name: 'Search work items' });
  await search.fill('security');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toHaveText('Review security boundaries');
  await expect(search).toBeFocused();
  await search.fill('');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('tbody tr').first()).toHaveText(
    'Write release documentation',
  );
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a work item title.');
  const title = page.getByRole('textbox', { name: 'New work item' });
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await title.fill('<img src=x onerror=alert(1)>');
  await expect(page.locator('#board-dirty')).toBeVisible();
  const held = await holdResponse(page, '**/work-board/add');
  await title.press('Enter');
  await held.started;
  await expect(
    page.getByRole('button', { name: 'Add work item' }),
  ).toBeDisabled();
  await expect(
    page.getByText('Updating work items', { exact: true }),
  ).toBeVisible();
  held();
  await held.wait();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(page.locator('tbody')).toContainText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('tbody img')).toHaveCount(0);
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('#board-dirty')).toBeHidden();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('#board-status')).toHaveText('Work item added');
  expect(documents).toEqual([board]);
  expect(errors).toEqual([]);
});

test('Phase 3 board retains keyed rows, Alpine state and local input during morphs and remains usable after Back/Forward', async ({
  page,
}) => {
  await page.goto(board);
  await page.getByRole('button', { name: 'Local board click' }).click();
  await expect(page.locator('#board-local')).toHaveText('1');
  await page.locator('#board-note').fill('Local draft');
  await page.locator('tr[data-nv-key=work-1]').evaluate((element) => {
    Reflect.set(window, 'phase3Row', element);
  });
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('#board-order')).toHaveText('descending');
  expect(
    await page
      .locator('tr[data-nv-key=work-1]')
      .evaluate((element) => Reflect.get(window, 'phase3Row') === element),
  ).toBe(true);
  await expect(page.locator('#board-note')).toHaveValue('Local draft');
  await expect(page.locator('#board-local')).toHaveText('1');
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Work board', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reverse title order' }).click();
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'About this starter' }),
  ).toBeVisible();
});

test('Phase 3 board accessibility covers initial, validation and empty states', async ({
  page,
}) => {
  await page.goto(board);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Search work items' })
    .fill('no-matching-row');
  await expect(page.locator('tbody')).toHaveText('No matching items');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
