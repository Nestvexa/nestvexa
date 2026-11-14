import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

/*
 * examples/showcase dashboard: Vue, React (@nestvexa/ui chart wrapper) and
 * Svelte islands beside a Live component, all server-rendered, hydrated with
 * their own strategies, under the page's strict CSP.
 */
const base = exampleUrl('showcase', 3124);
const password = 'showcase-demo-2026';
test.describe.configure({ timeout: 180_000 });

async function signIn(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // CSP violations are reported to the page before anything else runs.
  await page.addInitScript(() => {
    const violations: string[] = [];
    Reflect.set(window, 'nvCspViolations', violations);
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(base + '/app');
  return { context, page, errors };
}
const violations = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'nvCspViolations') as string[]);

test('all three islands are server-rendered under the strict CSP', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const response = await ada.page.request.get(base + '/app');
  expect(response.headers()['content-security-policy']).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  const html = await response.text();
  for (const id of ['throughput-chart', 'member-chart', 'pulse-widget'])
    expect(html).toMatch(
      new RegExp(
        `data-nv-island="${id}"[^>]*data-nv-ssr|data-nv-ssr[^>]*data-nv-island="${id}"`,
      ),
    );
  // Real SSR output, not the fallback: the @nestvexa/ui SVG chart and its
  // data table, and the Svelte widget's text.
  expect(html).toContain('class="nv-chart');
  expect(html).toContain('id="member-chart-data"');
  expect(html).toContain('Open and done tasks by member');
  expect(html).toMatch(/id="pulse-progress"[^>]*>\d+ of \d+ tasks done/);
  expect(html).not.toContain('Loading the member chart');
  // No inline style attributes or inline scripts in what the islands print.
  expect(html).not.toMatch(/<[a-z]+[^>]* style="/);
  expect(html).not.toMatch(
    /<script(?![^>]*type="(?:module|application\/json)")[^>]*>/,
  );
  // The page context and the message subset are inert JSON scripts.
  expect(html).toContain(
    '<script type="application/json" id="nv-islands-context">',
  );
  expect(html).toContain('<script type="application/json" id="nv-i18n">');
  await ada.context.close();
});

test('islands hydrate with their own strategies, talk through the event bridge and keep state across Live updates', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const page = ada.page;
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  const stream = page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await page.goto(base + '/app');
  expect((await stream).status()).toBe(200);
  const vue = page.locator('[data-nv-island="throughput-chart"]');
  const react = page.locator('[data-nv-island="member-chart"]');
  const svelte = page.locator('[data-nv-island="pulse-widget"]');

  // Svelte hydrates when idle, Vue when visible.
  await expect(svelte.locator('.pulse')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await expect(vue.locator('.island-chart')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  // React waits for an interaction: nothing of it is loaded yet.
  await expect(react.locator('.island-chart')).toHaveAttribute(
    'data-hydrated',
    'false',
  );
  expect(requested.some((url) => /member-chart.*\.js$/.test(url))).toBe(false);
  await react.hover();
  await expect(react.locator('.island-chart')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  expect(requested.some((url) => /member-chart.*\.js$/.test(url))).toBe(true);
  for (const island of [vue, react, svelte])
    await expect(island).not.toHaveAttribute('data-nv-mismatch', /.*/);

  // Local state in each island.
  await vue.locator('#chart-range-recent').click();
  await expect(vue.locator('#dashboard-chart-table tbody tr')).toHaveCount(4);
  await react.getByRole('button', { name: 'Lines' }).click();
  await expect(react.getByRole('button', { name: 'Lines' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(react.locator('.nv-chart__line').first()).toBeVisible();
  await svelte.locator('#pulse-toggle').click();
  await expect(svelte.locator('#pulse-progress')).toContainText(
    'of tasks done',
  );
  await expect(svelte.locator('#pulse-progress')).toContainText('%');
  // React → Svelte through the validated islands event bridge.
  await react.getByRole('button', { name: 'Focus on Ben Ortiz' }).click();
  await expect(svelte.locator('#pulse-focus')).toHaveText(
    /^Focused on Ben Ortiz: \d+ open tasks?\.$/,
  );
  const focus = await svelte.locator('#pulse-focus').textContent();
  // A forged event with an invalid detail is dropped by the accept check.
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('island:member.focus', {
        detail: { name: '<img src=x>', open: 'many' },
      }),
    ),
  );
  await expect(svelte.locator('#pulse-focus')).toHaveText(focus ?? '');

  // A Live update next to the islands re-renders the panel only.
  await page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  await expect(vue.locator('#dashboard-chart-table tbody tr')).toHaveCount(4);
  await expect(react.getByRole('button', { name: 'Lines' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(svelte.locator('#pulse-toggle')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(svelte.locator('#pulse-focus')).toHaveText(focus ?? '');

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  expect(await violations(page)).toEqual([]);
  expect(ada.errors).toEqual([]);
  await ada.context.close();
});
