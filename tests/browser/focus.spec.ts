import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3102' });

for (const [action, button, unavailable] of [
  ['disableEditor', 'Disable focus target', 'disabled'],
  ['hideEditor', 'Hide focus target', 'hidden'],
] as const) {
  test(`a server update that makes the focused input ${unavailable} moves focus to its component`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    const component = page.locator('[data-nv-component]');
    await expect(component).toHaveAttribute('aria-busy', 'false');
    const target = page.getByLabel('Focus target', { exact: true });
    await target.fill('Retained local draft');
    await target.focus();
    const release = await holdResponse(page, `**/counter/${action}`);
    try {
      // Invoke the real action without moving keyboard focus to its button.
      await page
        .getByRole('button', { name: button, exact: true })
        .evaluate((element) => {
          if (!(element instanceof HTMLButtonElement))
            throw new Error('Missing action button');
          element.click();
        });
      await release.started;
      await expect(target).toBeFocused();
    } finally {
      release();
      await release.wait();
    }
    await expect(component).toHaveAttribute('data-nv-revision', '1');
    if (unavailable === 'disabled') await expect(target).toBeDisabled();
    else await expect(target).toBeHidden();
    await expect(target).toHaveValue('Retained local draft');
    await expect(component).toBeFocused();
    await expect(component).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Increment', exact: true }),
    ).toBeFocused();
    await expect(component).not.toHaveAttribute('tabindex');
    expect(errors).toEqual([]);
  });
}

test('a pending server update preserves a new focus target outside its component', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const component = page.locator('[data-nv-component]');
  await expect(component).toHaveAttribute('aria-busy', 'false');
  const target = page.getByLabel('Focus target', { exact: true });
  await target.focus();
  const release = await holdResponse(page, '**/counter/hideEditor');
  const outside = page.getByRole('link', { name: 'About', exact: true });
  try {
    await page
      .getByRole('button', { name: 'Hide focus target', exact: true })
      .evaluate((element) => {
        if (!(element instanceof HTMLButtonElement))
          throw new Error('Missing action button');
        element.click();
      });
    await release.started;
    await outside.focus();
    await expect(outside).toBeFocused();
  } finally {
    release();
    await release.wait();
  }
  await expect(component).toHaveAttribute('data-nv-revision', '1');
  await expect(target).toBeHidden();
  await expect(outside).toBeFocused();
  await expect(component).not.toHaveAttribute('tabindex');
  expect(errors).toEqual([]);
});
