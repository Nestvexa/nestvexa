import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('content-addressed modules boot Live and Alpine under the host CSP', async ({
  page,
}) => {
  const errors: string[] = [];
  const assets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/_nestvexa/assets/')) assets.push(path);
  });
  await page.goto('/');
  await expect(page.locator('#count')).toHaveText('0');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Local Alpine click' }).click();
  await expect(page.locator('#alpine-local')).toHaveText('1');
  await page.getByRole('button', { name: 'Alpine server increment' }).click();
  await expect(page.locator('#count')).toHaveText('2');
  await expect(page.locator('#alpine-server')).toHaveText('2');
  await expect(page.locator('#alpine-local')).toHaveText('1');
  const versions = new Set(assets.map((path) => path.split('/')[3]));
  expect(versions.size).toBe(1);
  const version = [...versions][0];
  expect(version).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(assets.map((path) => path.split('/').at(-1)))).toEqual(
    new Set([
      'index.js',
      'bindings.js',
      'control-state.js',
      'events.js',
      'form-reset.js',
      'grammar.js',
      'listeners.js',
      'loading.js',
      'model-scheduler.js',
      'models.js',
      'morph.js',
      'protocol.js',
      'transport.js',
      'alpine-adapter.js',
      'alpine.js',
    ]),
  );
  const boot = await page.request.get('/assets/boot.js');
  expect(boot.headers()['cache-control']).toBe('no-store');
  const unknown = await page.request.get(
    `/_nestvexa/assets/${version}/index.js.map`,
  );
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['cache-control']).toBe('no-store');
  expect(errors).toEqual([]);
});
