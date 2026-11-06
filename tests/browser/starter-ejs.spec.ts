import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// examples/starter-ejs: EJS layouts, partials and helpers through Nest
// @Render, a Live component template in EJS, and a no-JavaScript form.
const base = exampleUrl('starter-ejs', 3114);
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function open(page: Page, path = '/'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  return errors;
}

test('EJS layout, partial and helpers render escaped, SEO-friendly HTML', async ({
  page,
}) => {
  const errors = await open(page);
  await expect(page).toHaveTitle('Nestvexa with EJS · Nestvexa EJS starter');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /EJS/,
  );
  await expect(page.locator('h1')).toHaveText('Nestvexa with EJS');
  await expect(page.locator('main')).toContainText('lists 4 features');
  await expect(page.locator('#features li')).toHaveCount(4);
  await expect(page.locator('nav a[aria-current="page"]')).toHaveText('Home');
  await expect(page.locator('#untrusted')).toHaveText(
    '<script>alert("escaped by <%= %>")</script>',
  );
  await expect(page.locator('#untrusted script')).toHaveCount(0);
  await expect(page.locator('footer')).toContainText(
    String(new Date().getUTCFullYear()),
  );
  await page.getByRole('link', { name: 'About' }).click();
  await expect(page.locator('h1')).toHaveText('About the EJS starter');
  await expect(page.locator('nav a[aria-current="page"]')).toHaveText('About');
  expect(errors).toEqual([]);
});

test('the EJS Live component acts and synchronizes models without a reload', async ({
  page,
}) => {
  const errors = await open(page);
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  const counter = page.locator('[data-nv-name="counter"]');
  await counter.getByRole('button', { name: 'Increase' }).click();
  await counter.getByRole('button', { name: 'Increase' }).click();
  await expect(page.locator('#count')).toHaveText('2');
  const hostile = '<img src=x onerror=alert(1)>';
  await page.locator('#counter-name').fill(hostile);
  await expect(page.locator('#greeting')).toHaveText(`Hello, ${hostile}!`);
  await expect(page.locator('#greeting img')).toHaveCount(0);
  await counter.getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('#count')).toHaveText('0');
  // The model value survives the action round trip.
  await expect(page.locator('#counter-name')).toHaveValue(hostile);
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test('the contact form posts and rejects forged submissions', async ({
  page,
}) => {
  await open(page, '/contact');
  // Missing token / cross-origin posts are refused before any field is read.
  const forged = await page.request.post(base + '/contact', {
    headers: { origin: base },
    form: { _csrf: 'not-the-token', name: 'Mallory', message: 'x'.repeat(20) },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  const token = await page.locator('input[name="_csrf"]').inputValue();
  const crossOrigin = await page.request.post(base + '/contact', {
    headers: { origin: 'http://evil.example' },
    form: { _csrf: token, name: 'Mallory', message: 'x'.repeat(20) },
    maxRedirects: 0,
  });
  expect(crossOrigin.status()).toBe(403);
  await expect(page.locator('#contact-sent')).toHaveCount(0);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the contact form validates and succeeds through post/redirect/get', async ({
    page,
  }) => {
    await open(page, '/contact');
    await page.getByLabel('Name').fill('A');
    await page.getByLabel('Message').fill('short');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page).toHaveURL(base + '/contact');
    await expect(page.locator('#contact-errors')).toBeVisible();
    await expect(page.locator('#contact-name-error')).toHaveText(
      'Enter a name between 2 and 60 characters.',
    );
    await expect(page.getByLabel('Name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Submitted values come back so the user can correct them.
    await expect(page.getByLabel('Message')).toHaveValue('short');
    await page.getByLabel('Name').fill('Ada <b>Lovelace</b>');
    await page.getByLabel('Message').fill('Hello from a browser without JS.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('#contact-sent')).toHaveText(
      'Thanks, Ada <b>Lovelace</b>. Your message was received.',
    );
    await expect(page.locator('#contact-sent b')).toHaveCount(0);
    // The notice is shown once; a reload re-requests the page with GET.
    await page.reload();
    await expect(page.locator('#contact-sent')).toHaveCount(0);
  });

  test('server-rendered pages are complete without JavaScript', async ({
    page,
  }) => {
    await open(page);
    await expect(page.locator('#count')).toHaveText('0');
    // With scripting disabled the <noscript> hint is rendered as real content.
    await expect(
      page.getByRole('link', { name: 'contact form' }),
    ).toBeVisible();
  });
});

test('accessibility: home, Live state and contact errors have no axe violations', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  await page
    .locator('[data-nv-name="counter"]')
    .getByRole('button', { name: 'Increase' })
    .click();
  await expect(page.locator('#count')).toHaveText('1');
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
  await page.goto(base + '/contact');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#contact-errors')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
});
