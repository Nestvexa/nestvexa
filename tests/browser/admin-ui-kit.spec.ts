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
