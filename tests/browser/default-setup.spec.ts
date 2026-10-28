import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const home = 'http://127.0.0.1:3102/';

test('default umbrella boots one client with CSP Alpine and preserves local state on Live updates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(home);
  expect(response?.headers()['content-security-policy']).toContain(
    "script-src 'self'",
  );
  await expect(
    page.getByRole('heading', { name: 'Nestvexa default Live setup' }),
  ).toBeVisible();
  await expect(page.locator('script[type=module]')).toHaveAttribute(
    'src',
    '/_nestvexa/boot.js',
  );
  await page
    .getByRole('button', { name: 'Local Alpine click', exact: true })
    .click();
  await expect(page.locator('#local')).toHaveText('1');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#double')).toHaveText('2');
  await expect(page.locator('#local')).toHaveText('1');
  await page
    .getByRole('button', { name: 'Alpine server click', exact: true })
    .click();
  await expect(page.locator('#count')).toHaveText('2');
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('#saved img')).toHaveCount(0);
  await expect(page.locator('#local')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('default startup survives persisted page lifecycle with deferred drafts and is idempotent', async ({
  page,
}) => {
  await page.goto(home);
  await page
    .getByRole('button', { name: 'Local Alpine click', exact: true })
    .click();
  await expect(page.locator('#local')).toHaveText('1');
  await page
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Draft survives');
  await page.evaluate(async () => {
    window.dispatchEvent(
      new PageTransitionEvent('pagehide', { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    );
    // A second module element shares the browser module cache and must not reinitialize Alpine.
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/_nestvexa/boot.js';
    document.head.append(script);
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Duplicate boot failed'));
    });
  });
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(
    page.getByRole('textbox', { name: 'Name', exact: true }),
  ).toHaveValue('Draft survives');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('#saved')).toHaveText('Draft survives');
  await expect(page.locator('#local')).toHaveText('1');
});

test('default starter isolates browser sessions and leaves native REST available', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const page = await first.newPage();
    const other = await second.newPage();
    await Promise.all([page.goto(home), other.goto(home)]);
    await page.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(page.locator('#count')).toHaveText('1');
    await expect(other.locator('#count')).toHaveText('0');
    const health = await second.request.get(`${home}api/health`);
    expect(await health.json()).toEqual({ status: 'ok' });
  } finally {
    await first.close();
    await second.close();
  }
});

test('default starter accessibility and ordinary document navigation', async ({
  page,
}) => {
  await page.goto(home);
  await page
    .getByRole('button', { name: 'Local Alpine click', exact: true })
    .click();
  await expect(page.locator('#local')).toHaveText('1');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'About this starter' }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Nestvexa default Live setup' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
});
