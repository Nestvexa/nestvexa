import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('cookie-backed live actions update without reload, retain ignored DOM and mount once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#count')).toHaveText('0');
  await page.evaluate(() => {
    document.documentElement.dataset['navigationMarker'] = 'same-document';
  });
  await page.getByLabel('Independent local note').fill('keep this local note');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#double')).toHaveText('2');
  await expect(page.getByLabel('Independent local note')).toHaveValue(
    'keep this local note',
  );
  expect(
    await page.locator('html').getAttribute('data-navigation-marker'),
  ).toBe('same-document');
  await page.getByRole('button', { name: 'Decrease' }).click();
  await expect(page.locator('#count')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('model submit preserves focus, escapes text and shows pending status', async ({
  page,
}) => {
  await page.goto('/');
  const field = page.getByLabel('Display name');
  await field.fill('<img src=x onerror=alert(1)>');
  await field.press('Enter');
  await expect(page.locator('#saved')).toHaveText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('#saved img')).toHaveCount(0);
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Slow increase' }).click();
  await expect(page.locator('[nv\\:loading]')).toBeVisible();
  await field.fill('edit during request');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(field).toHaveValue('edit during request');
  await expect(page.locator('[nv\\:loading]')).toBeHidden();
  await field.press('Enter');
  await expect(page.locator('#saved')).toHaveText('edit during request');
});

test('server rejects cross-session snapshots, CSRF, stale revisions and forged origins', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const alice = await first.newPage();
    const bob = await second.newPage();
    await alice.goto('http://127.0.0.1:3101');
    await bob.goto('http://127.0.0.1:3101');
    const marker = alice.locator('[data-nv-component]');
    const snapshot = await marker.getAttribute('data-nv-snapshot');
    const csrf = await marker.getAttribute('data-nv-csrf');
    const bobCsrf = await bob
      .locator('[data-nv-component]')
      .getAttribute('data-nv-csrf');
    if (!snapshot || !csrf || !bobCsrf) throw new Error('Missing live markers');
    const requestId = await alice.evaluate(() => crypto.randomUUID());
    const payload = {
      protocol: 'nestvexa-live/1',
      requestId,
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    };
    const endpoint = 'http://127.0.0.1:3101/_nestvexa/live/counter/increment';
    const headers = {
      origin: 'http://127.0.0.1:3101',
      'x-nestvexa-csrf': csrf,
    };
    expect(
      (
        await first.request.post(endpoint, {
          data: payload,
          headers: { origin: headers.origin },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await first.request.post(endpoint, {
          data: payload,
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await second.request.post(endpoint, {
          data: payload,
          headers: { ...headers, 'x-nestvexa-csrf': bobCsrf },
        })
      ).status(),
    ).toBe(410);
    await alice.getByRole('button', { name: 'Increase', exact: true }).click();
    await expect(alice.locator('#count')).toHaveText('1');
    expect(
      (await first.request.post(endpoint, { data: payload, headers })).status(),
    ).toBe(409);
    await expect(bob.locator('#count')).toHaveText('0');
  } finally {
    await first.close();
    await second.close();
  }
});

test('accessibility: keyboard action keeps focus and announces live changes', async ({
  page,
}) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Increase', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#count')).toHaveText('1');
  await expect(button).toBeFocused();
  await expect(page.locator('#count')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#status')).toHaveText('Updated');
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('CSP Alpine plugin invokes Live and preserves isolated local state across morphs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Local Alpine click' }).click();
  await expect(page.locator('#alpine-local')).toHaveText('1');
  await page.getByRole('button', { name: 'Alpine server increment' }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#alpine-server')).toHaveText('1');
  await expect(page.locator('#alpine-local')).toHaveText('1');
  await page.getByRole('button', { name: 'Alpine save name' }).click();
  await expect(page.locator('#saved')).toHaveText('From Alpine');
  await expect(page.getByLabel('Display name')).toHaveValue('From Alpine');
  await expect(page.locator('#alpine-local')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('safe data bindings update text, attributes, dirty state, visibility and focus', async ({
  page,
}) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.doctype?.name)).toBe('html');
  const field = page.getByLabel('Display name');
  await expect(page.locator('#name-preview')).not.toHaveAttribute(
    'nv:cloak',
    '',
  );
  await expect(page.locator('#dirty-name')).toBeHidden();
  await field.fill('temporary edit');
  await expect(page.locator('#dirty-name')).toBeVisible();
  await field.fill('');
  await expect(page.locator('#dirty-name')).toBeHidden();
  await field.fill('<b>Plain text</b>');
  await expect(page.locator('#name-preview')).toHaveText('<b>Plain text</b>');
  await expect(page.locator('#name-preview b')).toHaveCount(0);
  await expect(page.locator('#name-preview')).toHaveAttribute(
    'title',
    '<b>Plain text</b>',
  );
  await expect(page.locator('#dirty-name')).toBeVisible();
  await expect(page.locator('#health-link')).toHaveAttribute(
    'href',
    '/api/health',
  );
  await field.press('Enter');
  await expect(page.locator('#saved')).toHaveText('<b>Plain text</b>');
  await expect(page.locator('#dirty-name')).toBeHidden();
  const hide = page.getByRole('button', { name: 'Hide detail' });
  await hide.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#visibility-area')).toBeHidden();
  await expect(page.locator('#visibility-area')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(page.locator('[data-nv-component]')).toBeFocused();
  await page.getByRole('button', { name: 'Toggle detail' }).click();
  await expect(page.locator('#visibility-area')).toBeVisible();
});
