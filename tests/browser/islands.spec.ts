import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const base = process.env['NESTVEXA_HYBRID_URL'] ?? 'http://127.0.0.1:3112';
const url = `${base}/hybrid`;
const log = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { nvIslandLog?: string[] }).nvIslandLog ?? [],
  );
const diagnostics = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        nvIslands: {
          diagnostics(): { id: string; state: string; hydration: string }[];
        };
      }
    ).nvIslands
      .diagnostics()
      .map(({ id, state, hydration }) => ({ id, state, hydration })),
  );

test('React, Vue and Svelte islands mount independently and survive Live updates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/islands/'))
      scripts.push(new URL(request.url()).pathname);
  });
  await page.goto(url);
  await expect(page.locator('#chart-title')).toHaveText('Revenue by quarter');
  await page
    .locator('[data-nv-island="activity-feed"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Dashboard opened',
  );
  await expect(page.locator('#feed-items li').nth(1)).toHaveText(
    '<b>escaped</b> markup stays text',
  );
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  await expect
    .poll(async () =>
      (await diagnostics(page)).every((entry) =>
        ['mounted', 'error'].includes(entry.state),
      ),
    )
    .toBe(true);
  // Each island loads its own manifest bundle (separate framework chunk graphs).
  for (const name of ['react-chart', 'react-kpi', 'vue-feed', 'svelte-widget'])
    expect(
      scripts.some((path) =>
        new RegExp(`^/islands/${name}-[A-Z0-9]{8}\\.js$`).test(path),
      ),
    ).toBe(true);

  await page.getByRole('button', { name: 'Quarter 2' }).click();
  await expect(page.locator('#chart-selected')).toHaveText(
    'Selected quarter 2',
  );
  await page.locator('#feed-draft').fill('local Vue draft');
  await page.getByRole('button', { name: 'Toggle status' }).click();
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  // The event bridge carried the React selection to the Vue feed.
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Chart quarter 2 selected',
  );

  // A Live update re-renders the component that owns the React island.
  await page.getByRole('button', { name: 'Add notification' }).click();
  await expect(page.locator('#notification-count')).toHaveText('1');
  await expect(page.locator('#chart-selected')).toHaveText(
    'Selected quarter 2',
  );
  await expect(page.locator('#feed-draft')).toHaveValue('local Vue draft');
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  expect(
    (await log(page)).filter((entry) => entry.endsWith(':mount')).sort(),
  ).toEqual([
    'activity-feed:mount',
    'react-kpi:mount',
    'revenue-chart:mount',
    'status-widget:mount',
  ]);
  expect(errors).toEqual([]);
});

test('removing and reinserting an island cleans up and remounts exactly once', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('#chart-title')).toBeVisible();
  await page.getByRole('button', { name: 'Quarter 3' }).click();
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('[data-nv-island="revenue-chart"]')).toHaveCount(0);
  await expect.poll(() => log(page)).toContain('revenue-chart:unmount');
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('#chart-title')).toBeVisible();
  await expect(page.locator('#chart-selected')).toHaveText(
    'No quarter selected',
  );
  await expect
    .poll(async () =>
      (await log(page)).filter((entry) => entry.startsWith('revenue-chart')),
    )
    .toEqual([
      'revenue-chart:mount',
      'revenue-chart:unmount',
      'revenue-chart:mount',
    ]);
  // Repeated scans never double-mount (chart, KPI, feed and widget).
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { nvIslands: { mounted: number } }).nvIslands
            .mounted,
      ),
    )
    .toBe(4);
});

test('a failing island keeps its fallback and does not affect others', async ({
  page,
}) => {
  await page.goto(url);
  const broken = page.locator('[data-nv-island="broken-island"]');
  await expect(broken).toHaveAttribute('data-nv-island-failed', '');
  await expect(broken).toHaveText(
    'This widget is unavailable; the page keeps working.',
  );
  await expect(page.locator('#chart-title')).toBeVisible();
});

test('islands call typed server actions, including a long-running job', async ({
  page,
  request,
}) => {
  await page.goto(url);
  // React hook (dashboard.record-event).
  await page.getByRole('button', { name: 'Quarter 1' }).click();
  await expect(page.locator('#chart-events')).toHaveText('1 events recorded');
  // Vue composable: a validation error surfaces as a typed field issue.
  await page
    .locator('[data-nv-island="activity-feed"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#feed-total')).toHaveText('Not saved yet');
  // SSR markup is visible before hydration; interact once the island mounted.
  for (const id of ['activity-feed', 'status-widget'])
    await expect(page.locator(`[data-nv-island="${id}"]`)).toHaveAttribute(
      'data-nv-island-mounted',
      '',
    );
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('#feed-total')).toHaveText('Enter 1-80 characters');
  await expect(page.locator('#feed-draft')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.locator('#feed-draft').fill('Quarterly review');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('#feed-total')).toHaveText('2 events recorded');
  // Svelte store with server-verified signed island props.
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  await page.getByRole('button', { name: 'Toggle status' }).click();
  await expect(page.locator('#widget-workspace')).toHaveText('Saved for demo');
  // Tampered signed props are rejected by the server.
  const tampered = await page.evaluate(async () => {
    const root = document.querySelector('[data-nv-island="status-widget"]');
    const token = root?.getAttribute('data-nv-props-token') ?? '';
    const csrf =
      document
        .querySelector('meta[name="nestvexa-csrf"]')
        ?.getAttribute('content') ?? '';
    const response = await fetch('/_nestvexa/actions/dashboard/set-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nestvexa-csrf': csrf },
      body: JSON.stringify({
        input: {
          online: true,
          props: '{"label":"Sync","workspace":"other-tenant"}',
          token,
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(tampered.status).toBe(400);
  expect(tampered.body.error.code).toBe('VALIDATION');
  // Job action: 202 ticket, polling with progress, final result.
  await page.getByRole('button', { name: 'Export report' }).click();
  await expect(page.locator('#report-status')).toHaveText(
    'Report ready: /reports/activity-4.csv (4 rows)',
  );
  // Without the session cookie and CSRF token, actions are refused.
  const anonymous = await request.post(
    `${base}/_nestvexa/actions/dashboard/record-event`,
    {
      headers: { origin: base, 'content-type': 'application/json' },
      data: { input: { kind: 'note.added', label: 'x' } },
    },
  );
  expect(anonymous.status()).toBe(401);
  // Every call produced a tracing span through the observability interface.
  const spans = (await (
    await page.request.get(`${base}/api/action-spans`)
  ).json()) as { attributes: Record<string, unknown> }[];
  const ids = spans.map((span) => span.attributes['nestvexa.action.id']);
  expect(ids).toEqual(
    expect.arrayContaining(['record-event', 'set-status', 'export-report']),
  );
});

test('server-rendered islands hydrate cleanly with shared theme tokens', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page
    .locator('[data-nv-island="status-widget"]')
    .scrollIntoViewIfNeeded();
  await expect
    .poll(async () =>
      (await diagnostics(page))
        .filter((entry) =>
          ['react-kpi', 'activity-feed', 'status-widget'].includes(entry.id),
        )
        .map((entry) => `${entry.id}:${entry.state}:${entry.hydration}`)
        .sort(),
    )
    .toEqual([
      'activity-feed:mounted:hydrated',
      'react-kpi:mounted:hydrated',
      'status-widget:mounted:hydrated',
    ]);
  await expect(page.locator('[data-nv-hydration-mismatch]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nvIslandMismatches: string[] })
          .nvIslandMismatches,
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Increment KPI' }).click();
  await expect(page.locator('#kpi-value')).toHaveText('Active users: 43');
  await expect(page.locator('#kpi-locale')).toHaveText('Locale en');
  expect(
    await page
      .locator('[data-nv-island="react-kpi"]')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--nv-accent'),
      ),
  ).toBe('#2f5bff');
  expect(errors).toEqual([]);
});

test('hydration mismatches are reported per framework', async ({ page }) => {
  await page.goto(`${base}/hybrid/diagnostics`);
  for (const id of ['origin-react', 'origin-vue', 'origin-svelte'])
    await expect(page.locator(`[data-nv-island="${id}"]`)).toHaveAttribute(
      'data-nv-hydration-mismatch',
      '',
    );
  await expect
    .poll(async () =>
      (
        await page.evaluate(
          () =>
            (window as unknown as { nvIslandMismatches: string[] })
              .nvIslandMismatches,
        )
      ).sort(),
    )
    .toEqual(
      expect.arrayContaining([
        'origin-react:react',
        'origin-svelte:svelte',
        'origin-vue:vue',
      ]),
    );
  // Recovery: the browser rendering wins after the mismatch.
  await expect(
    page.locator('[data-nv-island="origin-vue"] .origin'),
  ).toHaveText('Rendered in browser');
});

test('without JavaScript, SSR markup, fallbacks and noscript content remain', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('#kpi-value')).toHaveText('Active users: 42');
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Dashboard opened',
  );
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  await expect(page.locator('[data-nv-island="revenue-chart"]')).toHaveText(
    'Loading chart…',
  );
  // Browser automation disables scripts after parsing, so <noscript> stays raw
  // text here; assert the server sent it next to the island root.
  const noscript = page.locator(
    'noscript[data-nv-island-noscript="activity-feed"]',
  );
  await expect(noscript).toHaveCount(1);
  expect(await noscript.textContent()).toContain(
    'Live activity updates need JavaScript.',
  );
  await context.close();
});

test('navigation cleans up islands and wins the race against a loading chunk', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = 0;
  await page.route(/\/islands\/vue-feed-[A-Z0-9]{8}\.js$/, async (route) => {
    // Hold only the first request: the feed chunk is loading during navigation.
    if (delayed++ === 0) await held;
    await route.continue();
  });
  await page.goto(url);
  await expect(page.locator('#chart-title')).toBeVisible();
  await expect.poll(() => delayed).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'About this dashboard' }).click();
  await expect(page.locator('#about-text')).toBeVisible();
  await expect.poll(() => log(page)).toContain('revenue-chart:unmount');
  release();
  await page.waitForTimeout(300);
  // The feed was removed while its chunk loaded: it never mounted.
  expect(await log(page)).not.toContain('activity-feed:mount');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nvIslands: { mounted: number } }).nvIslands
          .mounted,
    ),
  ).toBe(0);
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await page
    .locator('[data-nv-island="activity-feed"]')
    .scrollIntoViewIfNeeded();
  await expect.poll(() => log(page)).toContain('activity-feed:mount');
  expect(
    (await log(page)).filter((entry) => entry === 'activity-feed:mount'),
  ).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('accessibility: hybrid dashboard passes automated checks', async ({
  page,
}) => {
  // Several framework islands plus axe can exceed 30s in Firefox on loaded hosts.
  test.setTimeout(60_000);
  await page.goto(url);
  await expect(page.locator('#chart-title')).toBeVisible();
  await page
    .locator('[data-nv-island="status-widget"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#widget-status')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
