import { test, expect } from '@playwright/test';
import { exampleUrl } from './example-url.js';

const starter = exampleUrl('starter-hbs', 3100);

test('real MVC navigation and escaped script content', async ({ page }) => {
  await page.goto(`${starter}/`);
  expect(await page.evaluate(() => document.doctype?.name)).toBe('html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nestvexa');
  await expect(page.locator('pre')).toContainText('<script>');
  expect(await page.locator('script').count()).toBe(0);
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveTitle('About Nestvexa');
  await page.goBack();
  await expect(page).toHaveTitle('Nestvexa');
});

test('accessibility: landmarks and keyboard navigation work without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(starter);
  await page.bringToFront();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
  const nextLink = 'Tab';
  await page.keyboard.press(nextLink);
  await expect(
    page.getByRole('link', { name: 'Nestvexa', exact: true }),
  ).toBeFocused();
  await page.keyboard.press(nextLink);
  await page.keyboard.press('Enter');
  await expect(page).toHaveTitle('About Nestvexa');
  await context.close();
});

test('native API routes coexist with the rendered pages', async ({
  request,
}) => {
  const response = await request.get(`${starter}/api/health`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual({
    status: 'ok',
    renderer: 'native-nest',
  });
});

for (const javaScriptEnabled of [false, true]) {
  test(`contact form fallback validates on the server and re-renders errors (JavaScript ${javaScriptEnabled ? 'enabled' : 'disabled'})`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    await page.goto(`${starter}/contact`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contact');
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Invalid input: the server answers 422 and keeps the escaped values.
    await page.getByLabel('Email', { exact: true }).fill('not-an-email');
    await page
      .getByLabel('Message', { exact: true })
      .fill('<script>alert(1)</script>');
    const [invalid] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/contact') &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Send message' }).click(),
    ]);
    expect(invalid.status()).toBe(422);
    await expect(page).toHaveTitle('Contact: fix the errors');
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Name: Enter your name.');
    await expect(summary).toContainText('Email: Enter an email address');
    await expect(summary).not.toContainText('Message:');
    const name = page.getByLabel('Name', { exact: true });
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('Enter your name.');
    await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
      'not-an-email',
    );
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
      '<script>alert(1)</script>',
    );
    expect(await page.locator('main script').count()).toBe(0);

    // The summary links move to the field; keyboard submission works.
    await summary.getByRole('link', { name: /^Name:/ }).click();
    await expect(page).toHaveURL(/#name$/);
    await name.fill('Ada');
    await page.getByLabel('Email', { exact: true }).fill('ada@example.com');
    await page.getByLabel('Email', { exact: true }).press('Enter');
    await expect(page).toHaveURL(`${starter}/contact?sent=1`);
    await expect(page.getByRole('status')).toHaveText(
      'Thanks, your message was received.',
    );
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');

    // Reloading the result page is a GET: nothing is submitted twice.
    const reload = await page.reload();
    expect(reload?.request().method()).toBe('GET');
    await context.close();
  });
}

test('contact form refuses cross-origin and non-text submissions', async ({
  request,
}) => {
  const foreign = await request.post(`${starter}/contact`, {
    headers: { origin: 'https://attacker.example' },
    form: { name: 'Ada', email: 'ada@example.com', message: 'hi' },
    maxRedirects: 0,
  });
  expect(foreign.status()).toBe(403);
  const repeated = await request.post(`${starter}/contact`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'name[]=a&name[]=b&email=ada%40example.com&message=hi',
    maxRedirects: 0,
  });
  expect(repeated.status()).toBe(422);
  expect(await repeated.text()).toContain('Send this field once, as text.');
  const accepted = await request.post(`${starter}/contact`, {
    form: { name: 'Ada', email: 'ada@example.com', message: 'hi' },
    maxRedirects: 0,
  });
  expect(accepted.status()).toBe(303);
  expect(accepted.headers()['location']).toBe('/contact?sent=1');
});
