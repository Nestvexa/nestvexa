import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const board = 'http://127.0.0.1:3102/board';
const prompt = 'Remove the first visible sample work item?';

test('native confirmation cancels without HTTP, then keyboard approval invokes one real Nest action', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  const messages: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/removeFirst'))
      requests.push(request.url());
  });
  const response = await page.goto(board);
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self'",
  );
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const remove = page.getByRole('button', {
    name: 'Remove first visible item',
    exact: true,
  });
  page.once('dialog', async (dialog) => {
    messages.push(dialog.message());
    expect(dialog.type()).toBe('confirm');
    await dialog.dismiss();
  });
  await remove.focus();
  await remove.press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'data-nv-revision',
    '0',
  );
  expect(requests).toEqual([]);
  page.once('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.accept();
  });
  await remove.press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('#board-status')).toHaveText('Work item removed');
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(requests).toHaveLength(1);
  expect(messages).toEqual([prompt, prompt]);
  expect(errors).toEqual([]);
});

test('confirmed actions retain a usable empty state and can add a new item after removing all seeds', async ({
  page,
}) => {
  await page.goto(board);
  await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toBe(prompt);
    await dialog.accept();
  });
  const remove = page.getByRole('button', {
    name: 'Remove first visible item',
    exact: true,
  });
  for (let revision = 1; revision <= 3; revision++) {
    await remove.click();
    await expect(page.locator('[data-nv-name=work-board]')).toHaveAttribute(
      'data-nv-revision',
      String(revision),
    );
  }
  await expect(page.locator('tbody')).toHaveText('No matching items');
  await remove.click();
  await expect(page.locator('#board-status')).toHaveText(
    'No matching work item to remove',
  );
  await page
    .getByRole('textbox', { name: 'New work item' })
    .fill('A new item after empty');
  await page
    .getByRole('button', { name: 'Add work item', exact: true })
    .click();
  await expect(page.locator('tbody')).toHaveText('A new item after empty');
  await expect(page.locator('tr[data-nv-key]')).toHaveAttribute(
    'data-nv-key',
    'work-1',
  );
});

test('confirmation is presentation only: direct calls still require the correct session and CSRF', async ({
  page,
  browser,
}) => {
  await page.goto(board);
  const marker = await page
    .locator('[data-nv-name=work-board]')
    .evaluate((root) => ({
      endpoint: root.getAttribute('data-nv-endpoint'),
      csrf: root.getAttribute('data-nv-csrf'),
      snapshot: root.getAttribute('data-nv-snapshot'),
    }));
  if (!marker.endpoint || !marker.csrf || !marker.snapshot)
    throw new Error('Missing owner state');
  const endpoint = new URL(marker.endpoint + '/removeFirst', board).href;
  const data = {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    revision: 0,
    snapshot: marker.snapshot,
    updates: {},
    input: null,
  };
  const headers = {
    origin: 'http://127.0.0.1:3102',
    'x-nestvexa-csrf': marker.csrf,
  };
  expect(
    (
      await page.request.post(endpoint, {
        headers: { ...headers, 'x-nestvexa-csrf': 'wrong' },
        data,
      })
    ).status(),
  ).toBe(403);
  const other = await browser.newContext();
  try {
    const guest = await other.newPage();
    await guest.goto(board);
    const csrf = await guest
      .locator('[data-nv-name=work-board]')
      .getAttribute('data-nv-csrf');
    if (!csrf) throw new Error('Missing other identity');
    expect(
      (
        await other.request.post(endpoint, {
          headers: { ...headers, 'x-nestvexa-csrf': csrf },
          data,
        })
      ).status(),
    ).toBe(410);
  } finally {
    await other.close();
  }
  // The valid owner's raw request has no confirmation claim. Server policies
  // enforce permission; a UI prompt cannot be evidence of consent or identity.
  const allowed = await page.request.post(endpoint, {
    headers,
    data: { ...data, requestId: randomUUID() },
  });
  expect(allowed.status()).toBe(201);
  const result = (await allowed.json()) as {
    component: { revision: number };
    state: { rows: unknown[] };
  };
  expect(result.component.revision).toBe(1);
  expect(result.state.rows).toHaveLength(2);
});
