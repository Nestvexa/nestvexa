import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3102' });

/** Inspect only the public application exported by the already-loaded real boot module. */
async function bootOperation(
  page: Page,
  operation: 'hide' | 'dispose',
): Promise<void> {
  await page.evaluate(async (operation) => {
    const path: string = '/_nestvexa/boot.js';
    const loaded: unknown = await import(path);
    if (typeof loaded !== 'object' || loaded === null)
      throw new Error('Missing boot module');
    const app: unknown = Reflect.get(loaded, 'app');
    if (typeof app !== 'object' || app === null)
      throw new Error('Missing public boot application');
    if (operation === 'dispose') {
      const dispose: unknown = Reflect.get(app, 'dispose');
      if (typeof dispose !== 'function')
        throw new Error('Missing public disposal API');
      Reflect.apply(dispose, app, []);
      return;
    }
    const client: unknown = Reflect.get(app, 'client');
    if (typeof client !== 'object' || client === null)
      throw new Error('Missing public client');
    const set: unknown = Reflect.get(client, 'set');
    const target = document.getElementById('visibility-target');
    if (typeof set !== 'function' || !target)
      throw new Error('Missing visibility state fixture');
    Reflect.apply(set, client, [target, 'panelVisible', false]);
  }, operation);
}

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return errors;
}

async function invoke(page: Page, button: string): Promise<void> {
  await page
    .getByRole('button', { name: button, exact: true })
    .evaluate((element) => {
      if (!(element instanceof HTMLButtonElement))
        throw new Error('Missing action button');
      element.click();
    });
}

test('visibility focus cleanup preserves a later host tabindex value after a real server update', async ({
  page,
}) => {
  const errors = await start(page);
  const root = page.locator('[data-nv-component]');
  await page.getByLabel('Visibility focus target', { exact: true }).focus();
  const release = await holdResponse(page, '**/counter/hidePanel');
  try {
    await invoke(page, 'Hide visibility panel');
    await release.started;
  } finally {
    release();
    await release.wait();
  }
  await expect(root).toHaveAttribute('data-nv-revision', '1');
  await expect(page.locator('#visibility-panel')).toBeHidden();
  await expect(root).toBeFocused();
  await expect(root).toHaveAttribute('tabindex', '-1');
  await root.evaluate((element) => element.setAttribute('tabindex', '0'));
  await page.getByRole('link', { name: 'About', exact: true }).focus();
  await expect(root).toHaveAttribute('tabindex', '0');
  expect(errors).toEqual([]);
});

test('local visibility focusability is released when the default application is disposed', async ({
  page,
}) => {
  const errors = await start(page);
  const root = page.locator('[data-nv-component]');
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  await page.getByLabel('Visibility focus target', { exact: true }).focus();
  await bootOperation(page, 'hide');
  await expect(page.locator('#visibility-panel')).toBeHidden();
  await expect(root).toBeFocused();
  await expect(root).toHaveAttribute('tabindex', '-1');
  await bootOperation(page, 'dispose');
  await expect(root).not.toHaveAttribute('tabindex');
  expect(requests).toBe(0);
  expect(errors).toEqual([]);
});

test('loading focus cleanup preserves a later host tabindex value while a real response is held', async ({
  page,
}) => {
  const errors = await start(page);
  const root = page.locator('[data-nv-component]');
  await page.getByLabel('Loading focus target', { exact: true }).focus();
  const release = await holdResponse(page, '**/counter/slowPanel');
  try {
    await invoke(page, 'Run loading focus');
    await release.started;
    await expect(page.locator('#loading-panel')).toBeHidden();
    await expect(root).toBeFocused();
    await expect(root).toHaveAttribute('tabindex', '-1');
    await root.evaluate((element) => element.setAttribute('tabindex', '0'));
    await page.getByRole('link', { name: 'About', exact: true }).focus();
    await expect(root).toHaveAttribute('tabindex', '0');
  } finally {
    release();
    await release.wait();
  }
  await expect(root).toHaveAttribute('data-nv-revision', '1');
  await expect(page.locator('#loading-panel')).toBeVisible();
  await expect(root).toHaveAttribute('tabindex', '0');
  expect(errors).toEqual([]);
});

test('disposing pending loading work releases focusability and never replays the action', async ({
  page,
}) => {
  const errors = await start(page);
  const root = page.locator('[data-nv-component]');
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  await page.getByLabel('Loading focus target', { exact: true }).focus();
  const release = await holdResponse(page, '**/counter/slowPanel');
  try {
    await invoke(page, 'Run loading focus');
    await release.started;
    await expect(page.locator('#loading-panel')).toBeHidden();
    await expect(root).toBeFocused();
    await expect(root).toHaveAttribute('tabindex', '-1');
    await bootOperation(page, 'dispose');
    await expect(root).not.toHaveAttribute('tabindex');
    await expect(page.locator('#loading-panel')).toBeVisible();
  } finally {
    release();
    await release.wait();
  }
  await expect(root).toHaveAttribute('data-nv-revision', '0');
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});
