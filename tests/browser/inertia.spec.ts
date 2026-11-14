import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

// Drives examples/inertia-basic, whose browser bundle uses the official
// @inertiajs/react 3.10.0 / @inertiajs/core 3.10.0 client (no custom router).
const base =
  process.env['NESTVEXA_INERTIA_BASIC_URL'] ?? 'http://127.0.0.1:3103';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __nestvexaDocument?: string }).__nestvexaDocument =
      'same';
  });
}

async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __nestvexaDocument?: string })
        .__nestvexaDocument === 'same',
  );
}

function inertiaRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.headers()['x-inertia'] === 'true') seen.push(request);
  });
  return seen;
}

test.describe('official Inertia client against the Nest adapter', () => {
  test('boots from the embedded page object and loads deferred props', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const requests = inertiaRequests(page);
    const response = await page.goto(base);
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(
      page.getByRole('heading', { name: 'Welcome to Nestvexa Inertia' }),
    ).toBeVisible();
    await expect(page.getByTestId('app-name')).toHaveText(
      'Nestvexa Inertia demo',
    );
    await expect(page).toHaveTitle('Home · Nestvexa Inertia');
    await expect(page.getByTestId('stats')).toHaveText(/^Users: \d+$/);
    const deferred = requests.find(
      (request) => request.headers()['x-inertia-partial-data'] === 'stats',
    );
    expect(deferred?.headers()['x-inertia-partial-component']).toBe('Home');
    expect(errors).toEqual([]);
  });

  test('navigates with links via XHR and performs partial reloads', async ({
    page,
  }) => {
    await page.goto(base);
    await expect(page.getByTestId('stats')).toHaveText(/^Users:/);
    await markDocument(page);
    const requests = inertiaRequests(page);
    const visitsBefore = await page.getByTestId('visits').textContent();
    const reload = page.waitForResponse(
      (response) =>
        response.request().headers()['x-inertia-partial-data'] === 'extra',
    );
    await page.getByRole('button', { name: 'Load extra' }).click();
    const partial = await reload;
    expect(partial.headers()['x-inertia']).toBe('true');
    const body = (await partial.json()) as { props: Record<string, unknown> };
    expect(Object.keys(body.props).sort()).toEqual(['errors', 'extra']);
    await expect(page.getByTestId('extra')).toHaveText(
      /Loaded by a partial reload/,
    );
    await expect(page.getByTestId('visits')).toHaveText(visitsBefore ?? '');
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page).toHaveURL(`${base}/users`);
    await expect(
      page.getByRole('list', { name: 'Users' }).getByRole('listitem').first(),
    ).toHaveText('Ada Lovelace');
    expect(await sameDocument(page)).toBe(true);
    expect(requests.some((request) => request.url() === `${base}/users`)).toBe(
      true,
    );
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Welcome to Nestvexa Inertia' }),
    ).toBeVisible();
    expect(await sameDocument(page)).toBe(true);
  });

  test('round-trips validation errors and redirects after a successful POST', async ({
    page,
    browserName,
  }) => {
    await page.goto(`${base}/users/create`);
    await markDocument(page);
    const submit = page.waitForResponse(
      (response) =>
        response.url() === `${base}/users` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const rejected = await submit;
    // The browser follows the 302 back to the form; the final XHR response is a page.
    expect(rejected.request().headers()['x-xsrf-token']).toBeTruthy();
    await expect(page.getByRole('alert')).toHaveText(
      'The name field is required.',
    );
    await expect(page.getByLabel('Name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect(page).toHaveURL(`${base}/users/create`);
    expect(await sameDocument(page)).toBe(true);
    const name = `Playwright ${browserName} ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(`${base}/users`);
    await expect(page.getByTestId('flash')).toHaveText(`User ${name} created`);
    await expect(
      page.getByRole('listitem').filter({ hasText: name }),
    ).toHaveCount(1);
    expect(await sameDocument(page)).toBe(true);
    // Flash is read-once on the server: the next visit does not repeat it.
    await page.getByRole('link', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByTestId('flash')).toHaveCount(0);
  });

  test('rejects unsafe requests without the XSRF header (host CSRF guard)', async ({
    page,
  }) => {
    await page.goto(`${base}/users/create`);
    const status = await page.evaluate(async () => {
      const response = await fetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
        body: JSON.stringify({ name: 'Forged' }),
      });
      return response.status;
    });
    expect(status).toBe(403);
  });

  test('keeps a once-shared prop on the client and skips it on later visits', async ({
    page,
  }) => {
    const requests = inertiaRequests(page);
    await page.goto(base);
    const regions = page.getByTestId('regions');
    await expect(regions).toHaveText(
      /^Regions: Europe, Americas \(load \d+\)$/,
    );
    const first = await regions.textContent();
    await markDocument(page);
    const visit = page.waitForResponse(
      (response) =>
        response.url() === `${base}/users` &&
        response.request().headers()['x-inertia'] === 'true',
    );
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    const response = await visit;
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    expect(await sameDocument(page)).toBe(true);
    // The official client reports the once prop it holds; the server skips it.
    const sent = requests.find((request) => request.url() === `${base}/users`);
    expect(sent?.headers()['x-inertia-except-once-props']).toBe('regions');
    const body = (await response.json()) as {
      props: Record<string, unknown>;
      onceProps?: Record<string, unknown>;
    };
    expect(body.props).not.toHaveProperty('regions');
    expect(body.onceProps).toEqual({
      regions: { prop: 'regions', expiresAt: null },
    });
    // ...and the page still shows the value resolved on the first visit.
    await expect(regions).toHaveText(first ?? '');
  });

  test('renders the configured error page for 404, 403 and 500 without exception details', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // A full visit to an unknown URL: an HTML document whose page is ErrorPage.
    const missing = await page.goto(`${base}/no-such-page`);
    expect(missing?.status()).toBe(404);
    expect(missing?.headers()['content-type']).toContain('text/html');
    await expect(
      page.getByRole('heading', { name: 'Error 404' }),
    ).toBeVisible();
    await expect(page.getByTestId('error-message')).toHaveText('Not Found');
    await expect(page.getByTestId('app-name')).toHaveText(
      'Nestvexa Inertia demo',
    );
    await markDocument(page);
    // Inertia visits: the official client swaps in the component (no modal,
    // no full reload) with the original status.
    const forbidden = page.waitForResponse(`${base}/admin`);
    await page.getByRole('link', { name: 'Admin' }).click();
    const reply = await forbidden;
    expect(reply.status()).toBe(403);
    expect(reply.headers()['x-inertia']).toBe('true');
    await expect(
      page.getByRole('heading', { name: 'Error 403' }),
    ).toBeVisible();
    await expect(page.getByTestId('error-message')).toHaveText('Forbidden');
    await expect(page).toHaveURL(`${base}/admin`);
    const broken = page.waitForResponse(`${base}/broken`);
    await page.getByRole('link', { name: 'Broken' }).click();
    expect((await broken).status()).toBe(500);
    await expect(
      page.getByRole('heading', { name: 'Error 500' }),
    ).toBeVisible();
    await expect(page.getByTestId('error-message')).toHaveText('Server Error');
    expect(await sameDocument(page)).toBe(true);
    // The production page carries no exception message or stack.
    const html = await page.content();
    expect(html).not.toContain('db-internal');
    expect(html).not.toContain('Administrators only');
    expect(html).not.toMatch(/\bat .+\.js:\d+/);
    await expect(page.locator('dialog, iframe')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('performs a full page reload when the asset version changes', async ({
    page,
  }) => {
    await page.goto(base);
    await expect(page.getByTestId('stats')).toHaveText(/^Users:/);
    await markDocument(page);
    const bumped = await page.evaluate(async () => {
      const token = decodeURIComponent(
        /(?:^|; )XSRF-TOKEN=([^;]+)/.exec(document.cookie)?.[1] ?? '',
      );
      const response = await fetch('/__test/version', {
        method: 'POST',
        headers: { 'X-XSRF-TOKEN': token },
      });
      return (await response.json()) as { version: string };
    });
    const conflict = page.waitForResponse(
      (response) => response.status() === 409,
    );
    const documentLoad = page.waitForResponse(
      (response) =>
        response.url() === `${base}/users` &&
        response.request().headers()['x-inertia'] === undefined,
    );
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    const response = await conflict;
    expect(response.headers()['x-inertia-location']).toBe('/users');
    expect(response.headers()['x-inertia-version']).toBe(bumped.version);
    await documentLoad;
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page).toHaveURL(`${base}/users`);
    expect(await sameDocument(page)).toBe(false);
    const version = await page.evaluate(
      () =>
        (
          JSON.parse(
            document.querySelector('script[data-page="app"]')?.textContent ??
              '{}',
          ) as { version?: string }
        ).version,
    );
    expect(version).toBe(bumped.version);
  });
});
