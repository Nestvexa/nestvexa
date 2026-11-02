import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Phase 14 representative admin product: i18n/RTL, UI kit keyboard behavior,
// feature flags, AI approval workflow and offline drafts on real Nest routes.
const base = 'http://127.0.0.1:3110';

async function open(page: Page, path = '/admin') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  // The browser module reveals the tablist once it has initialized.
  await expect(page.getByRole('tablist')).toBeVisible();
  return errors;
}
async function switchLocale(page: Page, label: 'English' | 'العربية') {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'lang',
    label === 'English' ? 'en' : 'ar',
  );
  await expect(page.getByRole('tablist')).toBeVisible();
}
function draftKeys(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('nv-draft:')),
  );
}
async function axe(page: Page) {
  // Contrast is only meaningful once opening/locale transitions have finished;
  // cancelled animations reject `finished` and count as done.
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

test('switches to Arabic RTL with mirrored layout and keeps the locale across Live updates', async ({
  page,
}) => {
  const errors = await open(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#page-title')).toHaveText('Products');
  await expect(page.locator('#product-summary')).toHaveText(
    '7 products, page 1 of 2',
  );
  const brand = page.locator('.admin-brand');
  const logout = page.locator('#logout');
  const ltrBrand = await brand.boundingBox();
  const ltrLogout = await logout.boundingBox();
  expect(ltrBrand && ltrLogout && ltrBrand.x < ltrLogout.x).toBe(true);

  await switchLocale(page, 'العربية');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#page-title')).toHaveText('المنتجات');
  await expect(page.locator('#product-summary')).toContainText('الصفحة 1 من 2');
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).direction,
    ),
  ).toBe('rtl');
  // Logical properties mirror the header: brand now sits on the right.
  const rtlBrand = await brand.boundingBox();
  const rtlLogout = await logout.boundingBox();
  expect(rtlBrand && rtlLogout && rtlBrand.x > rtlLogout.x).toBe(true);
  await expect(page.locator('#product-lamp td').nth(0)).toHaveText('إضاءة');
  await expect(page.locator('#product-lamp td').nth(1)).toContainText('€');
  const response = await page.request.get(base + '/admin');
  expect(response.headers()['content-language']).toBe('ar');
  expect(response.headers()['vary']).toContain('Accept-Language');

  // A Live action is a separate request: the locale is negotiated again from
  // the cookie, never stored in component state.
  await page.getByRole('button', { name: 'السعر' }).click();
  await expect(page.locator('th[aria-sort]')).toHaveCount(1);
  await expect(page.locator('th[aria-sort="ascending"]')).toContainText(
    'السعر',
  );
  await expect(page.locator('#product-table tbody th').first()).toHaveText(
    'Dot-grid notebook',
  );
  await expect(page.locator('#product-summary')).toContainText('الصفحة');

  // Arabic validation messages and Arabic-Indic digits in a translated form.
  await page.getByRole('button', { name: 'إضافة منتج' }).click();
  const dialog = page.locator('#product-dialog');
  await expect(dialog).toHaveAttribute('open', '');
  await page.locator('#product-save').click();
  await expect(page.locator('#product-name-error')).toHaveText(
    'أدخل حرفين على الأقل.',
  );
  await expect(page.locator('#product-name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.locator('#product-name').fill('Brass hook');
  await page.locator('#product-category').fill('مطب');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#product-price').fill('١٢٫٥');
  await page.locator('#product-save').click();
  await expect(dialog).not.toHaveAttribute('open', '');
  await expect(page.locator('#toasts [data-nv-ui-list]')).toContainText(
    'أُضيف Brass hook إلى الكتالوج.',
  );
  await switchLocale(page, 'English');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#product-summary')).toHaveText(
    '8 products, page 1 of 2',
  );
  expect(errors).toEqual([]);
});

test('keyboard-only tabs, dialog focus trap and combobox create a product with an announced toast', async ({
  page,
}) => {
  const errors = await open(page);
  // Tabs: roving tabindex, arrow keys and Home/End.
  const productsTab = page.getByRole('tab', { name: 'Products' });
  await productsTab.focus();
  await page.keyboard.press('ArrowRight');
  const assistantTab = page.getByRole('tab', { name: 'Assistant' });
  await expect(assistantTab).toBeFocused();
  await expect(assistantTab).toHaveAttribute('aria-selected', 'true');
  await expect(assistantTab).toHaveAttribute('tabindex', '0');
  await expect(productsTab).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('#admin-assistant-panel')).toBeVisible();
  await expect(page.locator('#admin-products-panel')).toBeHidden();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(productsTab).toBeFocused();
  await expect(page.locator('#admin-products-panel')).toBeVisible();

  // Dialog: opened from the keyboard, focus moves inside and stays inside.
  const trigger = page.getByRole('button', { name: 'Add product' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#product-dialog');
  await expect(dialog).toHaveAttribute('open', '');
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press(step % 5 === 4 ? 'Shift+Tab' : 'Tab');
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('#product-dialog')),
      ),
    ).toBe(true);
  }
  // Background content is inert while the modal is open.
  expect(
    await page.evaluate(() => {
      const outside = document.getElementById('activity-refresh');
      outside?.focus();
      return document.activeElement === outside;
    }),
  ).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toHaveAttribute('open', '');
  await expect(trigger).toBeFocused();

  // Create a product with the keyboard only.
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveAttribute('open', '');
  await page.locator('#product-name').focus();
  await page.keyboard.type('Bamboo tray');
  await page.keyboard.press('Tab');
  const combobox = page.locator('#product-category');
  await expect(combobox).toBeFocused();
  await page.keyboard.type('kit');
  await expect(combobox).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.locator('#product-category-listbox [role="option"]:visible'),
  ).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(combobox).toHaveAttribute(
    'aria-activedescendant',
    'product-category-opt-3',
  );
  await expect(page.locator('#product-category-opt-3')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(combobox).toHaveValue('Kitchen');
  await expect(page.locator('#product-category-value')).toHaveValue('kitchen');
  await expect(combobox).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#product-price').focus();
  await page.keyboard.type('18.50');
  await page.keyboard.press('Enter');
  await expect(dialog).not.toHaveAttribute('open', '');
  await expect(trigger).toBeFocused();
  // Toasts are rendered as text inside a polite live region.
  const toast = page.locator(
    '#toasts [role="status"][aria-live="polite"] [data-nv-ui-list]',
  );
  await expect(toast).toContainText('Bamboo tray was added to the catalog.');
  await expect(page.locator('#product-table tbody th').first()).toHaveText(
    'Bamboo tray',
  );
  await expect(page.locator('#activity-list')).toContainText('Bamboo tray');
  expect(errors).toEqual([]);
});

test('Arabic tabs mirror arrow keys in RTL', async ({ page }) => {
  await open(page);
  await switchLocale(page, 'العربية');
  const first = page.getByRole('tab', { name: 'المنتجات' });
  await first.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'المساعد' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'المساعد' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await switchLocale(page, 'English');
});

test('AI assistant streams a labeled test reply, requires server-side approval, and cancels', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await expect(page.locator('#assistant-provider')).toContainText(
    'not an AI model',
  );
  await page.locator('#assistant-prompt').fill('Please archive the desk lamp');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-approval')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#approval-summary')).toHaveText(
    'archiveProduct("Desk lamp")',
  );
  await expect(page.locator('#assistant-messages')).toContainText(
    'I need your approval first',
  );
  // Nothing has changed before a human approves.
  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.locator('#product-lamp td').last()).toHaveText('Active');
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await page.locator('#assistant-approve').click();
  await expect(page.locator('#assistant-messages')).toContainText(
    'Action approved and completed.',
  );
  await expect(page.locator('#assistant-messages')).toContainText(
    'is archived and no longer active',
    { timeout: 15_000 },
  );
  await expect(page.locator('#assistant-approval')).toHaveCount(0);
  await expect(page.locator('#toasts')).toContainText(
    'Desk lamp was archived.',
  );
  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.locator('#product-lamp td').last()).toHaveText('Archived');

  // Cancellation keeps the partial reply, marked incomplete, and never retries.
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await page.locator('#assistant-prompt').fill('write a long report');
  await page.locator('#assistant-send').click();
  await expect(page.locator('#assistant-status')).toHaveText(
    'Generating a reply…',
  );
  await expect(page.locator('#assistant-stream')).toContainText('Section 1');
  await expect(page.locator('#assistant-stop')).toBeEnabled();
  await page.locator('#assistant-stop').click();
  await expect(page.locator('#assistant-status')).toHaveText(
    'Stopped. The partial reply is kept.',
  );
  await expect(page.locator('#assistant-messages')).toContainText(
    '(stopped, incomplete)',
  );
  await expect(page.locator('#assistant-messages')).not.toContainText(
    'Section 12',
  );
  await expect(page.locator('#assistant-stop')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('offline drafts survive an interrupted save and restore without replaying it', async ({
  page,
  context,
}) => {
  await open(page);
  const saves: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/_nestvexa/live/product-form/save'))
      saves.push(request.url());
  });
  await page.getByRole('button', { name: 'Add product' }).click();
  await page.locator('#product-name').fill('Offline lamp');
  await page.locator('#product-price').fill('9.99');
  await page.locator('#product-notes').fill('Typed while travelling');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  const [key] = await draftKeys(page);
  const scope = await page
    .locator('meta[name="nv-draft-scope"]')
    .getAttribute('content');
  expect(key).toBe(`nv-draft:v1:${scope}:product-form`);
  const stored = await page.evaluate(
    (name) => localStorage.getItem(name) ?? '',
    key ?? '',
  );
  expect(stored).toContain('Offline lamp');
  // The CSRF token and other hidden inputs are never stored.
  expect(stored).not.toContain('_csrf');

  await context.setOffline(true);
  await page.locator('#product-save').click();
  await expect(page.locator('#product-draft-status')).toHaveText(
    'Not sent. Your draft is saved on this device. Save again when you are back online.',
  );
  await expect(page.locator('#product-form')).toHaveAttribute(
    'data-nv-draft-state',
    'interrupted',
  );
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#product-draft-status')).toHaveText(
    'Connection restored. Reload the page to review your saved draft, then save again.',
  );
  const attempted = saves.length;
  expect(attempted).toBeLessThanOrEqual(1);

  // Reload: the draft is restored, nothing is submitted automatically.
  await page.reload();
  await expect(page.getByRole('tablist')).toBeVisible();
  await expect(page.locator('#product-summary')).toHaveText(
    '7 products, page 1 of 2',
  );
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.locator('#product-name')).toHaveValue('Offline lamp');
  await expect(page.locator('#product-price')).toHaveValue('9.99');
  await expect(page.locator('#product-notes')).toHaveValue(
    'Typed while travelling',
  );
  await expect(page.locator('#product-draft-status')).toHaveText(
    'Draft restored from this device. Review it, then save.',
  );
  await page.waitForTimeout(500);
  expect(saves.length).toBe(attempted);

  // Only an explicit user submit saves; success clears the draft.
  await page.locator('#product-category').fill('light');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#product-save').click();
  await expect(page.locator('#product-dialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#product-summary')).toHaveText(
    '8 products, page 1 of 2',
  );
  expect(saves.length).toBe(attempted + 1);
  await expect.poll(() => draftKeys(page)).toHaveLength(0);
});

test('read-only snapshot is shown when the activity refresh fails offline', async ({
  page,
  context,
}) => {
  await open(page);
  await expect(page.locator('#activity-list')).toBeVisible();
  await context.setOffline(true);
  await page.locator('#activity-refresh').click();
  const copy = page.locator('#activity [data-nv-offline-copy]');
  await expect(copy).toBeVisible();
  // The copied markup is inert: no focus, no activation, no Live markers.
  await expect(copy.locator('[inert]')).toHaveCount(1);
  await expect(copy.locator('[data-nv-component]')).toHaveCount(0);
  await expect(page.locator('#activity')).toContainText(
    'Offline copy. Read-only until the connection returns.',
  );
  await expect(page.locator('#activity')).toHaveAttribute(
    'data-source',
    'cache',
  );
  await context.setOffline(false);
  await page.locator('#activity-refresh').click();
  await expect(page.locator('#activity')).toHaveAttribute(
    'data-source',
    'network',
  );
  await expect(page.locator('#activity [data-nv-offline-copy]')).toHaveCount(0);
});

test('logout clears every local draft through the explicit client API', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Add product' }).click();
  await page.locator('#product-name').fill('Private draft');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  await page.keyboard.press('Escape');
  const scope = await page
    .locator('meta[name="nv-draft-scope"]')
    .getAttribute('content');
  // First answer the logout POST without any server help (no
  // Clear-Site-Data, no session change): the explicit client API alone must
  // have cleared the drafts before the navigation.
  await page.route(base + '/logout', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><title>Signed out</title><p>Signed out</p></html>',
    }),
  );
  await page.locator('#logout').click();
  await expect(page.locator('p')).toHaveText('Signed out');
  expect(await draftKeys(page)).toEqual([]);
  await page.unroute(base + '/logout');
  await open(page);
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.locator('#product-name')).toHaveValue('');
  await expect(page.locator('#product-draft-status')).toHaveText('');
  await page.keyboard.press('Escape');
  // A real logout ends the session, so the next draft scope differs.
  await page.locator('#logout').click();
  await expect(page).toHaveURL(base + '/admin');
  await expect(page.getByRole('tablist')).toBeVisible();
  expect(await draftKeys(page)).toEqual([]);
  const next = await page
    .locator('meta[name="nv-draft-scope"]')
    .getAttribute('content');
  expect(next).not.toBe(scope);
});

test('server-enforced feature flags hide and refuse the disabled export', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#export-link')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('[data-flag="bulk-export"]')).toContainText('Off');
  await expect(page.locator('[data-flag="ai-assistant"]')).toContainText('On');
  const response = await page.request.get(
    base + '/admin/export.csv?flags=bulk-export',
  );
  expect(response.status()).toBe(404);
});

test('axe finds no WCAG A/AA violations in LTR and RTL, including the open dialog', async ({
  page,
}) => {
  await open(page);
  await axe(page);
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.locator('#product-dialog')).toHaveAttribute('open', '');
  await axe(page);
  await page.keyboard.press('Escape');
  await switchLocale(page, 'العربية');
  await axe(page);
  await page.getByRole('tab', { name: 'المساعد' }).click();
  await axe(page);
  await page.getByRole('tab', { name: 'الإعدادات' }).click();
  await axe(page);
  await switchLocale(page, 'English');
});

test('reduced motion and dark mode are honored by the theme', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await open(page);
  await page.getByRole('button', { name: 'Add product' }).click();
  const dialog = page.locator('#product-dialog');
  await expect(dialog).toHaveAttribute('open', '');
  const motion = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionDuration, style.animationName];
  });
  expect(motion[0]?.split(',').every((value) => parseFloat(value) === 0)).toBe(
    true,
  );
  expect(motion[1]).toBe('none');
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(background).toBe('rgb(18, 20, 23)');
  await page.keyboard.press('Escape');
  await axe(page);
  // The explicit theme switch overrides the system preference.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('#theme-select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe('rgb(255, 255, 255)');
});

test('without JavaScript every panel stays readable and the plain form creates a product', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(base + '/admin');
  await expect(page.locator('#admin-settings-panel')).toBeVisible();
  await expect(page.locator('#product-table')).toBeVisible();
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page).toHaveURL(base + '/admin/products/new');
  await page.locator('#product-name').fill('Plain form shelf');
  await page.locator('#product-category-fallback').selectOption('furniture');
  await page.locator('#product-price').fill('33');
  await page.locator('#product-save').click();
  await expect(page).toHaveURL(base + '/admin');
  await expect(page.locator('#toasts')).toContainText(
    'Plain form shelf was added to the catalog.',
  );
  await expect(page.locator('#product-summary')).toHaveText(
    '8 products, page 1 of 2',
  );
  await context.close();
});
