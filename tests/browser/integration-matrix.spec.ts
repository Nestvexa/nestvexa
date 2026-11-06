import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

/*
 * One Nest server, every master-prompt section 1.5 route (VISION-029..037),
 * exercised concurrently in the same process.
 */
const base = exampleUrl('integration-matrix', 3123);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('integration-matrix-image'),
]);

async function axe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}
/** Marks the document; the marker survives only same-document updates. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
}
async function sameDocument(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(window, 'nvSameDocument'));
}

test('VISION-029 / renders HBS with layout, helpers, escaping and SEO metadata', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const response = await page.goto(base + '/');
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page).toHaveTitle(
    'Nestvexa integration matrix · Nestvexa matrix',
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /HBS, Live, Inertia React\/Vue\/Svelte/,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${base}/`,
  );
  // Layout navigation and footer helper output.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('footer')).toContainText(
    String(new Date().getUTCFullYear()),
  );
  // Escaped interpolation: the payload is text, not a script element.
  await expect(page.locator('#home-untrusted')).toHaveText(
    '<script>alert("escaped")</script>',
  );
  await expect(page.locator('main script')).toHaveCount(0);
  // Application helper and built-in block helpers.
  await expect(page.locator('#featured li')).toHaveCount(3);
  await expect(page.locator('.featured-price').first()).toHaveText('$249.00');
  await expect(page.locator('#featured li').first()).toContainText(
    '(oak, adjustable)',
  );
  await expect(page.locator('#featured li').nth(2)).toContainText('(no tags)');
  await axe(page);
  expect(errors).toEqual([]);
});

test('VISION-030 /counter runs Live actions, server validation and Alpine without a reload', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(base + '/counter');
  await markDocument(page);
  const value = page.locator('#counter-value');
  await expect(value).toHaveText('0');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(value).toHaveText('1');
  await expect(page.locator('#counter-double')).toHaveText('2');
  await page.locator('#counter-step').fill('3');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(value).toHaveText('4');
  // Server-side validation rejects an invalid step and leaves the count alone.
  await page.locator('#counter-step').fill('abc');
  await page.getByRole('button', { name: 'Decrease' }).click();
  await expect(page.locator('#counter-error')).toHaveText(
    'Step must be a whole number from 1 to 10.',
  );
  await expect(page.locator('#counter-step')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(value).toHaveText('4');
  await page.locator('#counter-step').fill('2');
  await page.getByRole('button', { name: 'Decrease' }).click();
  await expect(value).toHaveText('2');
  await expect(page.locator('#counter-error')).toHaveCount(0);
  // Alpine local state survives Live morphs; Alpine can call Live actions.
  await page.getByRole('button', { name: 'Local Alpine click' }).click();
  await page.getByRole('button', { name: 'Local Alpine click' }).click();
  await expect(page.locator('#alpine-clicks')).toHaveText('2');
  await page.getByRole('button', { name: 'Increase from Alpine' }).click();
  await expect(value).toHaveText('4');
  await expect(page.locator('#alpine-clicks')).toHaveText('2');
  expect(await sameDocument(page)).toBe(true);
  await axe(page);
  expect(errors).toEqual([]);
});

test('VISION-031 /products searches, sorts, paginates, validates and uploads', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  await page.goto(base + '/products');
  const names = () =>
    page
      .locator('#product-rows .product-name')
      .evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim()));
  await expect(page.locator('#product-rows tr')).toHaveCount(4);
  expect(await names()).toEqual([
    'Atlas desk',
    'Beacon lamp',
    'Cobalt chair',
    'Delta shelf',
  ]);
  await expect(page.locator('#product-summary')).toContainText('of 7');
  await axe(page);

  // Debounced live search (name or category) updates the URL.
  await page.locator('#product-search').fill('storage');
  await expect(page.locator('#product-rows tr')).toHaveCount(2);
  expect(await names()).toEqual(['Delta shelf', 'Granite tray']);
  await expect(page).toHaveURL(/q=storage/);
  await page.locator('#product-search').fill('');
  await expect(page.locator('#product-rows tr')).toHaveCount(4);

  // Server-side sort by price.
  await page
    .getByRole('button', { name: 'Toggle sort (name / price)' })
    .click();
  await expect(page.locator('#product-sort')).toHaveText('price');
  expect((await names())[0]).toBe('Granite tray');
  await expect(
    page.getByRole('columnheader', { name: 'Price' }),
  ).toHaveAttribute('aria-sort', 'ascending');
  await page
    .getByRole('button', { name: 'Toggle sort (name / price)' })
    .click();
  await expect(page.locator('#product-sort')).toHaveText('name');

  // Pagination link swaps the page without a full reload.
  await markDocument(page);
  await page.getByRole('link', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(`${base}/products?page=2`);
  expect(await names()).toEqual(['Ember heater', 'Fjord rug', 'Granite tray']);
  expect(await sameDocument(page)).toBe(true);

  // Server validation errors are announced next to the fields.
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.locator('#product-name-error')).toHaveText(
    'Enter at least 2 characters.',
  );
  await expect(page.locator('#product-price-error')).toBeVisible();
  await axe(page);

  // Create with an uploaded image; the image is downloadable by this session only.
  await page.locator('#product-name').fill('Zephyr vase <b>');
  await page.locator('#product-price').fill('12.50');
  await page.setInputFiles('#product-image', {
    name: 'vase.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('#product-image-status')).toHaveText(
    'Uploaded 1 file',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.locator('#product-message')).toHaveText(
    'Zephyr vase <b> was added with an image.',
  );
  await expect(page.locator('#product-rows b')).toHaveCount(0);
  const link = page.getByRole('link', {
    name: 'View image of Zephyr vase <b>',
  });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const image = await page.request.get(base + String(href));
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toContain('image/png');
  expect((await image.body()).equals(png)).toBe(true);
  // A request without this session's cookie cannot read it.
  const stranger = await request.get(base + String(href));
  expect(stranger.status()).toBeGreaterThanOrEqual(400);
  expect(errors).toEqual([]);
});

for (const root of ['react', 'vue', 'svelte'] as const) {
  const label = { react: 'React', vue: 'Vue', svelte: 'Svelte' }[root];
  const rootUrl = `${base}/admin/${root}`;
  const hydrated = (page: Page) =>
    expect(page.locator('html')).toHaveAttribute('data-hydrated', root);

  test(`VISION-032..034 /admin/${root} renders on the server and hydrates with deferred and partial props`, async ({
    page,
    request,
  }) => {
    // Axe plus SSR, deferred and partial requests: allow for loaded hosts.
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    // SSR: the first response already contains the page markup.
    const html = await (await request.get(rootUrl)).text();
    expect(html).toMatch(
      new RegExp(`<h1[^>]*>(<!--[^>]*-->)*${label} admin dashboard`),
    );
    expect(html).toContain('Loading stats…');
    expect(html).toContain(`"deferredProps":{"default":["stats"]}`);
    expect(html).not.toContain('"stats":');

    await page.goto(rootUrl);
    await hydrated(page);
    await expect(page.getByTestId('framework')).toHaveText(
      `Rendered by ${label}`,
    );
    // Deferred prop arrives through a follow-up partial request.
    await expect(page.getByTestId('stats')).toHaveText(/^Users: \d+$/);
    // Optional prop only on an explicit partial reload.
    await expect(page.getByTestId('extra')).toHaveCount(0);
    const partial = page.waitForRequest(
      (candidate) =>
        candidate.url() === rootUrl &&
        candidate.headers()['x-inertia-partial-data'] === 'extra',
    );
    await page.getByRole('button', { name: 'Load extra' }).click();
    await partial;
    await expect(page.getByTestId('extra')).toContainText(
      'Partial reload served at',
    );
    await axe(page);
    expect(errors).toEqual([]);
  });

  test(`VISION-032..034 /admin/${root} navigates and validates a form`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    await page.goto(rootUrl);
    await hydrated(page);
    await markDocument(page);
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await nav.getByRole('link', { name: 'New user' }).click();
    await expect(page).toHaveURL(`${rootUrl}/users/create`);
    await expect(
      page.getByRole('heading', { name: 'Create user' }),
    ).toBeVisible();
    // Server validation errors come back through the session.
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#name-error')).toHaveText(
      'The name field is required.',
    );
    await expect(page.locator('#email-error')).toHaveText(
      'The email must be a valid email address.',
    );
    await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
    await axe(page);
    const name = `Tester ${browserName} ${Date.now()}`;
    await page.locator('#name').fill(name);
    await page.locator('#email').fill('tester@example.test');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(`${rootUrl}/users`);
    await expect(page.getByTestId('flash')).toHaveText(`User ${name} created`);
    await expect(page.getByTestId('users')).toContainText(name);
    // Every step was an Inertia visit inside one document.
    expect(await sameDocument(page)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('Inertia form posts without the XSRF header are refused', async ({
  request,
}) => {
  const response = await request.post(`${base}/admin/react/users`, {
    headers: { 'x-inertia': 'true', 'content-type': 'application/json' },
    data: { name: 'Mallory', email: 'mallory@example.test' },
  });
  expect(response.status()).toBe(403);
});

test('VISION-035 /hybrid mounts React, Vue and Svelte islands beside a Live widget and calls a server action', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/islands/'))
      scripts.push(new URL(request.url()).pathname);
  });
  await page.goto(base + '/hybrid');
  await expect(page.locator('#chart-title')).toHaveText('Revenue by quarter');
  await page
    .locator('[data-nv-island="activity-feed"]')
    .scrollIntoViewIfNeeded();
  await expect(page.locator('#feed-items li').nth(1)).toHaveText(
    '<b>escaped</b> markup stays text',
  );
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  // Each framework is its own lazily loaded chunk from the allowlist.
  expect(scripts.some((path) => /chunks\/react-chart-/.test(path))).toBe(true);
  expect(scripts.some((path) => /chunks\/vue-feed-/.test(path))).toBe(true);
  expect(scripts.some((path) => /chunks\/svelte-widget-/.test(path))).toBe(
    true,
  );
  // Local island state, plus the cross-island event bridge.
  await page.getByRole('button', { name: 'Quarter 2' }).click();
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Chart quarter 2 selected',
  );
  await page.getByRole('button', { name: 'Toggle status' }).click();
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  // The independent Live widget updates without disturbing the islands.
  await page.getByRole('button', { name: 'Add notification' }).click();
  await expect(page.locator('#notification-count')).toHaveText('1');
  await expect(page.locator('#chart-selected')).toHaveText(
    'Selected quarter 2',
  );
  await expect(page.locator('#widget-status')).toHaveText('Sync: paused');
  // Universal server action: validated input, identity-owned result.
  await page.getByRole('button', { name: 'Add points' }).click();
  await expect(page.locator('#score-total')).toHaveText('3');
  await page.locator('#score-points').fill('4');
  await page.getByRole('button', { name: 'Add points' }).click();
  await expect(page.locator('#score-total')).toHaveText('7');
  await page.locator('#score-points').fill('50');
  await page.getByRole('button', { name: 'Add points' }).click();
  await expect(page.locator('#score-status')).toHaveText(/^Refused: /);
  await expect(page.locator('#score-total')).toHaveText('7');
  await axe(page);
  expect(errors).toEqual([]);
});

/** Decodes the channel list of the component's signed realtime token. */
async function tokenChannels(page: Page): Promise<string[]> {
  const token = await page
    .locator('[data-nv-name="realtime-panel"]')
    .getAttribute('data-nv-realtime');
  const body = String(token).split('.')[0] ?? '';
  const claims: unknown = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  );
  const channels =
    typeof claims === 'object' && claims !== null
      ? Reflect.get(claims, 'c')
      : undefined;
  return Array.isArray(channels) ? channels.map(String) : [];
}
async function openRealtime(browser: Browser, operator: boolean) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, 'nvRealtimeChannels', seen);
    window.addEventListener('nestvexa:realtime', (event) => {
      const detail: unknown = (event as CustomEvent).detail;
      const channel =
        typeof detail === 'object' && detail !== null
          ? Reflect.get(detail, 'channel')
          : undefined;
      seen.push(String(channel));
    });
  });
  const subscription = () =>
    page.waitForResponse((response) =>
      response.url().includes('/_nestvexa/realtime/sse?'),
    );
  const subscribed = subscription();
  await page.goto(base + '/realtime');
  expect((await subscribed).status()).toBe(200);
  if (operator) {
    // The re-rendered page opens its own subscription with the new token.
    const resubscribed = subscription();
    await page
      .getByRole('button', { name: 'Sign in as operator (demo)' })
      .click();
    await expect(page.locator('#realtime-role')).toHaveText(
      'Signed in as an operator (demonstration).',
    );
    expect((await resubscribed).status()).toBe(200);
  }
  return { context, page };
}
const seenChannels = (page: Page) =>
  page.evaluate(
    () => (Reflect.get(window, 'nvRealtimeChannels') as string[]) ?? [],
  );

test('VISION-036 /realtime delivers events across sessions and only to authorized channels', async ({
  browser,
}) => {
  // Three browser contexts with live SSE connections; WebKit on Windows is slow here.
  test.setTimeout(120_000);
  const guest = await openRealtime(browser, false);
  const first = await openRealtime(browser, true);
  const second = await openRealtime(browser, true);
  const errors = [guest.page, first.page, second.page].flatMap((page) =>
    collectErrors(page),
  );
  // The signer drops channels this identity may not read.
  expect(await tokenChannels(guest.page)).toEqual(['matrix:public']);
  expect(await tokenChannels(first.page)).toEqual([
    'matrix:ops',
    'matrix:public',
  ]);
  await expect(guest.page.locator('#realtime-restricted')).toBeVisible();
  await expect(
    guest.page.getByRole('button', { name: 'Raise alert' }),
  ).toHaveCount(0);

  // A public post from the guest refreshes both operators.
  const text = `Matrix ${Date.now()} <b>escaped</b>`;
  await guest.page.locator('#realtime-draft').fill(text);
  await guest.page.getByRole('button', { name: 'Post update' }).click();
  await expect(guest.page.locator('#realtime-posted')).toHaveText('1');
  for (const operator of [first.page, second.page]) {
    // Other browsers may post concurrently, so match this exact entry.
    await expect(
      operator.locator('#realtime-feed li').filter({ hasText: text }),
    ).toHaveCount(1);
    await expect(operator.locator('#realtime-feed b')).toHaveCount(0);
    await expect(operator.locator('#realtime-posted')).toHaveText('0');
  }

  // An operator alert reaches the other operator, never the guest.
  // The alert store is shared by every browser running this suite, so the
  // delivered `matrix:ops` event (not the list length) proves the push.
  await first.page.getByRole('button', { name: 'Raise alert' }).click();
  await expect.poll(() => seenChannels(second.page)).toContain('matrix:ops');
  await expect(second.page.locator('#realtime-alerts li').first()).toHaveText(
    /^Alert at /,
  );
  expect(await seenChannels(guest.page)).toContain('matrix:public');
  expect(await seenChannels(guest.page)).not.toContain('matrix:ops');
  await expect(guest.page.locator('#realtime-alerts')).toHaveCount(0);
  expect(errors).toEqual([]);
  for (const session of [guest, first, second]) await session.context.close();
});

test('VISION-036 /realtime page is accessible', async ({ page }) => {
  await page.goto(base + '/realtime');
  await expect(page.locator('#realtime-restricted')).toBeVisible();
  await axe(page);
});

test('VISION-037 /api/health is an ordinary Nest controller with its guard, pipe, interceptor and filter', async ({
  request,
}) => {
  const health = await request.get(base + '/api/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['content-type']).toContain('application/json');
  expect(await health.json()).toEqual({
    data: {
      status: 'ok',
      routes: [
        '/',
        '/counter',
        '/products',
        '/admin/react',
        '/admin/vue',
        '/admin/svelte',
        '/hybrid',
        '/realtime',
      ],
    },
    intercepted: true,
  });
  const denied = await request.get(base + '/api/health/secure');
  expect(denied.status()).toBe(401);
  expect(await denied.json()).toEqual({
    problem: { status: 401, title: 'A valid x-api-key header is required' },
  });
  const allowed = await request.get(base + '/api/health/secure', {
    headers: { 'x-api-key': 'matrix-demo-key' },
  });
  expect(await allowed.json()).toEqual({
    data: { status: 'ok', guarded: true },
    intercepted: true,
  });
  const piped = await request.get(base + '/api/health/square/12');
  expect(await piped.json()).toEqual({
    data: { value: 12, square: 144 },
    intercepted: true,
  });
  const rejected = await request.get(base + '/api/health/square/twelve');
  expect(rejected.status()).toBe(400);
  expect(await rejected.json()).toMatchObject({ problem: { status: 400 } });
});
