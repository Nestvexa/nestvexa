import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('self-owned wrapper attributes survive real Live child actions and escaped models', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const wrapper = page.locator('#self-widget');
  await wrapper.evaluate((element) => {
    element.setAttribute('class', 'widget-open');
    element.setAttribute('style', 'border: 2px solid currentColor');
    element.setAttribute('aria-expanded', 'true');
    Reflect.set(element, 'retainedWidget', true);
  });
  await page.getByLabel('Wrapper local note').fill('widget-local draft');
  await page
    .getByRole('button', { name: 'Wrapper increase', exact: true })
    .click();
  await expect(page.locator('#self-count')).toHaveText('1');
  await expect(wrapper).toHaveClass('widget-open');
  await expect(wrapper).toHaveAttribute('data-server-count', '0');
  await expect(wrapper).toHaveAttribute('aria-expanded', 'true');
  expect(
    await wrapper.evaluate((element) => Reflect.get(element, 'retainedWidget')),
  ).toBe(true);
  const field = page.getByLabel('Widget author', { exact: true });
  await field.fill('<b>Escaped child</b>');
  await expect(page.locator('#self-name-preview')).toHaveText(
    '<b>Escaped child</b>',
  );
  await page
    .getByRole('button', { name: 'Save wrapper name', exact: true })
    .click();
  await expect(page.locator('#saved')).toHaveText('<b>Escaped child</b>');
  await expect(wrapper.locator('#self-name-preview b')).toHaveCount(0);
  await expect(page.getByLabel('Wrapper local note')).toHaveValue(
    'widget-local draft',
  );
  await expect(wrapper).toHaveClass('widget-open');
  expect(errors).toEqual([]);
});

test('self-owned wrappers retain focus and newer child edits while descendant loading remains active', async ({
  page,
}) => {
  await page.goto('/');
  const field = page.getByLabel('Widget author', { exact: true });
  await field.fill('sent value');
  const release = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Delayed wrapper update', exact: true })
      .click();
    await release.started;
    await expect(page.locator('#self-loading')).toBeVisible();
    await field.fill('newer child edit');
    await field.evaluate((element) =>
      (element as HTMLInputElement).setSelectionRange(2, 5),
    );
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('#self-count')).toHaveText('1');
  await expect(page.locator('#self-loading')).toBeHidden();
  await expect(field).toHaveValue('newer child edit');
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((element) => {
      const input = element as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd];
    }),
  ).toEqual([2, 5]);
  await page
    .getByRole('button', { name: 'Save wrapper name', exact: true })
    .click();
  await expect(page.locator('#saved')).toHaveText('newer child edit');
});

test('changing wrapper ownership replaces it once and subsequent ordinary attributes update', async ({
  page,
}) => {
  await page.goto('/');
  const wrapper = page.locator('#self-widget');
  await wrapper.evaluate((element) => {
    Reflect.set(element, 'oldWidget', true);
    element.setAttribute('class', 'widget-open');
    const root = element.closest('[data-nv-component]');
    if (!root) throw new Error('Missing component');
    root.addEventListener('nestvexa:before-remove', (event) => {
      if (event.target === element)
        root.setAttribute('data-wrapper-removed', 'yes');
    });
  });
  await page.getByLabel('Wrapper local note').fill('old local note');
  await page
    .getByRole('button', { name: 'Toggle detail', exact: true })
    .click();
  await expect(wrapper).not.toHaveAttribute('nv:ignore.self', '');
  expect(
    await wrapper.evaluate((element) => Reflect.get(element, 'oldWidget')),
  ).toBeUndefined();
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-wrapper-removed',
    'yes',
  );
  await expect(page.getByLabel('Wrapper local note')).toHaveValue('');
  await page
    .getByRole('button', { name: 'Wrapper increase', exact: true })
    .click();
  await expect(wrapper).toHaveClass('server-wrapper-1');
  await expect(wrapper).toHaveAttribute('data-server-count', '1');
  await page
    .getByRole('button', { name: 'Toggle detail', exact: true })
    .click();
  await expect(wrapper).toHaveAttribute('nv:ignore.self', '');
  await page
    .getByRole('button', { name: 'Wrapper increase', exact: true })
    .click();
  await expect(page.locator('#self-count')).toHaveText('2');
  await expect(wrapper).toHaveAttribute('data-server-count', '1');
});
