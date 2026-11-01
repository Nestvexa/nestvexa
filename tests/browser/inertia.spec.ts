import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

// Drives examples/inertia-basic, whose browser bundle uses the official
// @inertiajs/react 3.10.0 / @inertiajs/core 3.10.0 client (no custom router).
const base = 'http://127.0.0.1:3103';

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
