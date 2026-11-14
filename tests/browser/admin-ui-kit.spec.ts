import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// UI kit showcase in the admin example (served by the admin-i18n web server):
// HBS-rendered primitives, keyboard behavior, a native bulk form and RTL.
const base = process.env['ADMIN_I18N_URL'] ?? 'http://127.0.0.1:3110';
// Cold first navigations (Live mount, three engines) can approach 30s on CI.
test.describe.configure({ timeout: 60_000 });

async function open(page: Page, path = '/admin/kit') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  // The browser module hides the collapsed menu once it has initialized.
  await expect(page.locator('#kit-actions-menu')).toBeHidden();
  return errors;
}
async function axe(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

test('renders the kit with breadcrumbs, a live badge and keyboard menus', async ({
  page,
}) => {
  const errors = await open(page, '/admin');
  await page.getByRole('link', { name: 'UI kit primitives' }).click();
  await expect(page.locator('#kit-actions-menu')).toBeHidden();
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: 'Admin' })).toHaveAttribute(
    'href',
    '/admin',
  );
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText(
    'UI kit primitives',
  );
  await expect(page.locator('#kit-unread')).toHaveAttribute('role', 'status');
  await expect(page.locator('#kit-unread')).toContainText(
    'unread notifications',
  );
  const menu = page.locator('#kit-actions-button');
  await menu.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: 'Back to admin' }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('menuitem', { name: 'Copy page link' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await axe(page);
  expect(errors).toEqual([]);
});

test('filters, selects and bulk-archives products through a native form', async ({
  page,
}) => {
  const errors = await open(page);
  const rows = page.locator('#kit-products tbody tr:visible');
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);
  await page.getByLabel('Category').selectOption({ index: 1 });
  const filtered = await rows.count();
  expect(filtered).toBeLessThan(total);
  await expect(page.locator('#kit-products-status')).toHaveText(
    `${filtered} results`,
  );
  await page.getByLabel('Category').selectOption('');
  await expect(rows).toHaveCount(total);
  const first = rows.first().locator('input[type="checkbox"]');
  await first.check();
  await expect(page.locator('#kit-products-status')).toHaveText('1 selected');
  await page.getByRole('button', { name: 'Archive selected' }).click();
  await expect(page.locator('#kit-archived')).toContainText(
    '1 product archived',
  );
  await expect(page.locator('#kit-products tbody tr').first()).toContainText(
    'Archived',
  );
  expect(errors).toEqual([]);
});

test('drives the server wizard, date picker and accordion', async ({
  page,
}) => {
  const errors = await open(page);
  await expect(page.locator('#kit-wizard-heading')).toHaveText(
    'Step 1 of 3: Details',
  );
  await page.getByRole('link', { name: 'Next step' }).click();
  await expect(page.locator('#kit-wizard-heading')).toHaveText(
    'Step 2 of 3: Pricing',
  );
  await expect(page.locator('[aria-current="step"]')).toContainText('Pricing');
  await expect(
    page
      .getByRole('navigation', { name: 'New product steps' })
      .getByRole('link', {
        name: 'Details',
      }),
  ).toHaveAttribute('href', '/admin/kit?step=details');
  await page.locator('#kit-launch').fill('2026-03-01');
  await expect(page.locator('#kit-launch-formatted')).toHaveText(
    'March 1, 2026',
  );
  const returns = page.locator('#kit-faq-returns-trigger');
  await returns.click();
  await expect(returns).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#kit-faq-shipping-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('mirrors the kit in Arabic and opens the drawer from the inline end', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'العربية', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#page-title')).toHaveText(
    'مكونات الواجهة الأساسية',
  );
  await expect(page.locator('#kit-actions-menu')).toBeHidden();
  await page.getByRole('button', { name: 'فتح المرشحات' }).click();
  const drawer = page.getByRole('dialog', { name: 'المرشحات' });
  await expect(drawer).toBeVisible();
  // side="end" anchors to the left edge in a right-to-left document.
  expect(Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(0);
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'فتح المرشحات' }),
  ).toBeFocused();
  await page.locator('#kit-launch').fill('2026-03-01');
  await expect(page.locator('#kit-launch-formatted')).not.toHaveText('');
  await axe(page);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(errors).toEqual([]);
});

test('charts the session catalog and keeps the chart in step with the data', async ({
  page,
}) => {
  const errors = await open(page);
  const chart = page.locator('#kit-overview');
  await expect(chart.locator('figcaption')).toHaveText('Catalog overview');
  const image = chart.getByRole('img', { name: 'Catalog overview' });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('aria-describedby', /kit-overview-desc/);
  // One bar per category and status, in the scripted, CSP-safe SVG.
  expect(await chart.locator('svg rect.nv-chart__bar').count()).toBe(10);
  const table = page.locator('#kit-overview-data');
  const lighting = table.getByRole('row', { name: /Lighting/ });
  const activeBefore = Number(
    await lighting.locator('td').nth(0).textContent(),
  );
  const archivedBefore = Number(
    await lighting.locator('td').nth(1).textContent(),
  );
  expect(activeBefore).toBeGreaterThan(0);
  // Archive one active lighting product through the data table.
  await page.getByLabel('Category').selectOption('lighting');
  const row = page
    .locator('#kit-products tbody tr:visible')
    .filter({ hasText: 'Active' })
    .first();
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Archive selected' }).click();
  await expect(page.locator('#kit-archived')).toContainText('archived');
  const after = page
    .locator('#kit-overview-data')
    .getByRole('row', { name: /Lighting/ });
  await expect(after.locator('td').nth(0)).toHaveText(String(activeBefore - 1));
  await expect(after.locator('td').nth(1)).toHaveText(
    String(archivedBefore + 1),
  );
  await axe(page);
  expect(errors).toEqual([]);
});

test('validates the feedback form on the server and wires errors to the fields', async ({
  page,
}) => {
  const errors = await open(page);
  const form = page.locator('#kit-feedback');
  await page.locator('#kit-email').fill('not-an-email');
  await page.locator('#kit-message').fill('short');
  await form.getByRole('radio', { name: 'High' }).check();
  await form.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page).toHaveURL(/\/admin\/kit#kit-feedback$/);
  const email = page.locator('#kit-email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAttribute('aria-describedby', /kit-email-error/);
  await expect(email).toHaveValue('not-an-email');
  await expect(page.locator('#kit-email-error')).toHaveAttribute(
    'role',
    'alert',
  );
  await expect(page.locator('#kit-email-error')).toHaveText(
    'Enter a valid email address.',
  );
  await expect(page.locator('#kit-topic-error')).toHaveText('Choose a topic.');
  await expect(page.locator('#kit-message-error')).toHaveText(
    'Write between 10 and 500 characters.',
  );
  // Valid choices survive the round trip; the radio group keeps its value.
  await expect(form.getByRole('radio', { name: 'High' })).toBeChecked();
  await expect(page.locator('#kit-message')).toHaveValue('short');
  await axe(page);
  // Fix the fields and send.
  await email.fill('ada@example.test');
  await page.locator('#kit-topic').selectOption('pricing');
  await page
    .locator('#kit-message')
    .fill('The price filter could remember my last choice.');
  await form.getByRole('checkbox', { name: 'Email me a reply' }).check();
  await form.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.locator('#kit-archived')).toContainText(
    'Thanks, your feedback was sent.',
  );
  await expect(page.locator('#kit-email')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('#kit-email-error')).toHaveCount(0);
  await expect(page.locator('#kit-email')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('renders the chart and form fields in Arabic', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'العربية', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(
    page.getByRole('img', { name: 'نظرة عامة على الكتالوج' }),
  ).toBeVisible();
  await expect(page.locator('label[for="kit-email"]')).toContainText(
    'البريد الإلكتروني',
  );
  await page
    .locator('#kit-feedback')
    .getByRole('button', { name: 'إرسال الملاحظات' })
    .click();
  await expect(page.locator('#kit-topic-error')).toHaveText('اختر موضوعًا.');
  await axe(page);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(errors).toEqual([]);
});
