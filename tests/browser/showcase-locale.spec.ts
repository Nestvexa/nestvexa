import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

/*
 * examples/showcase in English and Arabic (right to left) through
 * @nestvexa/i18n: the switch, mirrored layout, axe in both directions, and
 * the locale surviving Live updates, realtime refreshes and Inertia visits.
 */
const base = exampleUrl('showcase', 3124);
const password = 'showcase-demo-2026';
test.describe.configure({ timeout: 180_000 });

async function axe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}
async function signIn(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(base + '/app');
  return { context, page, errors };
}
async function direction(page: Page) {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    computed: getComputedStyle(document.documentElement).direction,
  }));
}
/** In a mirrored header the brand (first item) sits to the right of the nav. */
async function brandIsRightOfNav(page: Page): Promise<boolean> {
  const brand = await page.locator('.site-header .brand').boundingBox();
  const nav = await page.locator('.site-header nav').first().boundingBox();
  if (!brand || !nav) throw new Error('header not laid out');
  return brand.x > nav.x;
}

test('a guest switches the landing page to Arabic and back; both directions pass axe', async ({
  page,
}) => {
  await page.goto(base + '/');
  expect(await direction(page)).toEqual({
    lang: 'en',
    dir: 'ltr',
    computed: 'ltr',
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Nestvexa Showcase',
  );
  expect(await brandIsRightOfNav(page)).toBe(false);
  // One alternate URL per language for search engines.
  await expect(
    page.locator('link[rel="alternate"][hreflang="ar"]'),
  ).toHaveAttribute('href', /\?lang=ar$/);
  await expect(
    page.locator('link[rel="alternate"][hreflang="en"]'),
  ).toHaveAttribute('href', /\?lang=en$/);
  await axe(page);

  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page).toHaveURL(base + '/');
  expect(await direction(page)).toEqual({
    lang: 'ar',
    dir: 'rtl',
    computed: 'rtl',
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'معرض Nestvexa',
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /مساحة عمل/,
  );
  await expect(page.getByRole('link', { name: 'تسجيل الدخول' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'العربية' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The header is mirrored: logical properties and flex order follow `dir`.
  expect(await brandIsRightOfNav(page)).toBe(true);
  await axe(page);

  // The choice is a cookie: other pages follow it.
  await page.goto(base + '/login');
  expect((await direction(page)).dir).toBe('rtl');
  await expect(page.getByLabel('البريد الإلكتروني')).toBeVisible();
  await axe(page);

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page).toHaveURL(base + '/login');
  expect((await direction(page)).dir).toBe('ltr');
  await expect(page.getByLabel('Email')).toBeVisible();
  await axe(page);
});

test('the locale switch is allowlisted, CSRF-protected and never an open redirect', async ({
  page,
}) => {
  await page.goto(base + '/');
  const csrf =
    (await page
      .locator('.locale-switch input[name="_csrf"]')
      .getAttribute('value')) ?? '';
  const post = (form: Record<string, string>) =>
    page.request.post(base + '/locale', {
      form,
      headers: { origin: base },
      maxRedirects: 0,
    });
  const unknown = await post({ _csrf: csrf, locale: 'xx', return: '/' });
  expect(unknown.status()).toBe(400);
  const injected = await post({
    _csrf: csrf,
    locale: 'ar\r\nSet-Cookie: x=1',
    return: '/',
  });
  expect(injected.status()).toBe(400);
  const forged = await post({ _csrf: 'wrong', locale: 'ar', return: '/' });
  expect(forged.status()).toBe(403);
  const away = await post({
    _csrf: csrf,
    locale: 'ar',
    return: 'https://attacker.example/',
  });
  expect(away.status()).toBe(303);
  expect(away.headers()['location']).toBe('/');
  expect(away.headers()['set-cookie']).toContain('nv-locale=ar');
  // An unlisted query value falls back to the next source, never echoed.
  await page.goto(base + '/?lang=%3Cscript%3E');
  expect((await direction(page)).lang).toBe('ar');
});

test('Arabic survives Live updates, realtime refreshes and island interaction on the dashboard', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const ben = await signIn(browser, 'ben@harbor.test');
  await ada.page.getByRole('button', { name: 'العربية' }).click();
  await expect(ada.page).toHaveURL(base + '/app');
  const stream = ada.page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await ada.page.reload();
  expect((await stream).status()).toBe(200);
  expect(await direction(ada.page)).toEqual({
    lang: 'ar',
    dir: 'rtl',
    computed: 'rtl',
  });
  await expect(ada.page.locator('#metrics-heading')).toHaveText(
    'المؤشرات الحية',
  );
  await expect(ada.page.locator('#who')).toHaveText('Ada Park (مسؤول)');
  // Island props are translated on the server (SSR and hydration agree).
  await expect(ada.page.locator('#dashboard-chart-caption')).toContainText(
    'المهام المنجزة في كل أسبوع',
  );
  await expect(ada.page.locator('#member-chart-title')).toHaveText(
    'المهام المفتوحة والمنجزة حسب العضو',
  );
  await axe(ada.page);

  // A Live action renders its response in Arabic (the locale is negotiated
  // per request, not stored in the snapshot).
  await ada.page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  await ada.page.getByRole('button', { name: 'سجّل عملية نشر' }).click();
  await expect(ada.page.locator('#metrics-notice')).toHaveText(
    'سُجّلت عملية النشر.',
  );
  const before = Number(
    await ada.page.locator('#metric-deployments').textContent(),
  );

  // Ben (English) logs one; Ada's panel refreshes through realtime, in Arabic.
  await ben.page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(ben.page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  await expect(ada.page.locator('#metric-deployments')).toHaveText(
    String(before + 1),
  );
  await expect(ada.page.locator('#metrics-heading')).toHaveText(
    'المؤشرات الحية',
  );
  await expect(
    ada.page.getByRole('button', { name: 'سجّل عملية نشر' }),
  ).toBeVisible();
  await expect(ben.page.locator('#metrics-heading')).toHaveText('Live metrics');
  expect(
    await ada.page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
  ).toBe(true);
  expect((await direction(ada.page)).dir).toBe('rtl');

  // The Svelte widget formats the focus sentence in the browser with Arabic
  // plural rules from the hydrated message subset.
  const chart = ada.page.locator('[data-nv-island="member-chart"]');
  await chart.hover();
  await expect(chart.locator('.island-chart')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await expect(
    ada.page.locator('[data-nv-island="pulse-widget"] .pulse'),
  ).toHaveAttribute('data-hydrated', 'true');
  await chart.getByRole('button', { name: 'ركّز على Ben Ortiz' }).click();
  await expect(ada.page.locator('#pulse-focus')).toContainText(
    'التركيز على Ben Ortiz',
  );
  await axe(ada.page);
  expect(ada.errors).toEqual([]);
  await ada.context.close();
  await ben.context.close();
});

test('Arabic survives Inertia visits: server-rendered RTL, translated Vue pages, same document', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const page = ada.page;
  await page.getByRole('button', { name: 'العربية' }).click();
  // Server-rendered HTML is already right to left and translated.
  const raw = await (await page.request.get(base + '/insights')).text();
  expect(raw).toContain('<html lang="ar" dir="rtl">');
  expect(raw).toContain('تحليلات Harbor Studio');
  expect(raw).toContain('data-server-rendered="true"');

  await page.goto(base + '/insights');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'vue');
  expect(await direction(page)).toEqual({
    lang: 'ar',
    dir: 'rtl',
    computed: 'rtl',
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'تحليلات Harbor Studio',
  );
  await expect(page.locator('#throughput-heading')).toHaveText(
    'الإنجاز الأسبوعي',
  );
  await expect(page.locator('#analytics-chart-table tbody tr')).toHaveCount(8);
  await axe(page);

  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  await page.getByRole('link', { name: 'الأهداف' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الأهداف');
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  expect((await direction(page)).dir).toBe('rtl');
  await expect(page.getByRole('link', { name: 'التحليلات' })).toBeVisible();
  await axe(page);

  // Back to English from the Vue layout's own switch (a native form post).
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page).toHaveURL(base + '/insights/goals');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Goals');
  expect((await direction(page)).dir).toBe('ltr');
  await axe(page);
  expect(ada.errors).toEqual([]);
  await ada.context.close();
});
