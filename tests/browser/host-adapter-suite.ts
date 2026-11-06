import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

// Shared flows for examples/express-host and examples/fastify-host: the same
// src/app.ts (enforced byte-identical by tests/examples-hosts.test.ts) must
// behave identically on both Nest HTTP platforms.

export interface HostSuite {
  readonly platform: 'express' | 'fastify';
  readonly base: string;
}

const apiKey = { 'x-api-key': 'demo-key-not-a-secret' };

async function open(page: Page, base: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(base + '/');
  await expect(page.locator('[data-nv-name="counter"]')).toBeVisible();
  return errors;
}

/** The component's snapshot and CSRF token, as a forged client would read them. */
async function component(page: Page, name: string) {
  const root = page.locator(`[data-nv-name="${name}"]`);
  return {
    snapshot: (await root.getAttribute('data-nv-snapshot')) ?? '',
    csrf: (await root.getAttribute('data-nv-csrf')) ?? '',
  };
}

function livePayload(snapshot: string) {
  return {
    protocol: 'nestvexa-live/1',
    requestId: crypto.randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input: null,
  };
}

async function json(
  request: APIRequestContext,
  url: string,
  init: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    data?: unknown;
  } = {},
) {
  const response =
    init.method === 'POST'
      ? await request.post(url, {
          headers: init.headers ?? {},
          data: init.data,
        })
      : await request.get(url, { headers: init.headers ?? {} });
  return {
    status: response.status(),
    body: (await response.json()) as unknown,
  };
}

export function defineHostSuite({ platform, base }: HostSuite): void {
  test.describe(`${platform} host`, () => {
    test('renders HBS through the platform adapter and issues an HttpOnly guest cookie', async ({
      page,
      context,
      playwright,
    }) => {
      const errors = await open(page, base);
      await expect(page).toHaveTitle(`Nestvexa on ${platform}`);
      await expect(page.locator('#platform')).toHaveText(platform);
      const cookie = (await context.cookies(base)).find(
        (item) => item.name === 'nv_guest',
      );
      expect(cookie?.httpOnly).toBe(true);
      // Read the attribute from the header: WebKit on Windows reports cookie
      // SameSite values inconsistently through the cookie API.
      const fresh = await playwright.request.newContext();
      try {
        const header = (await fresh.get(base + '/')).headers()['set-cookie'];
        expect(header).toMatch(
          /^nv_guest=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400$/,
        );
      } finally {
        await fresh.dispose();
      }
      await page.getByRole('link', { name: 'About' }).click();
      await expect(page.locator('h1')).toHaveText('About this host');
      expect(errors).toEqual([]);
    });

    test('Live actions and validated forms update without a full reload', async ({
      page,
    }) => {
      const errors = await open(page, base);
      await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
      const counter = page.locator('[data-nv-name="counter"]');
      await counter.getByRole('button', { name: 'Increase' }).click();
      await counter.getByRole('button', { name: 'Increase' }).click();
      await expect(page.locator('#count')).toHaveText('2');
      await expect(page.locator('#doubled')).toHaveText('4');
      await counter.getByRole('button', { name: 'Decrease' }).click();
      await expect(page.locator('#count')).toHaveText('1');

      const book = page.locator('[data-nv-name="guestbook"]');
      await book.getByRole('button', { name: 'Sign' }).click();
      await expect(page.locator('#guestbook-error')).toHaveText(
        'Write at least 2 characters.',
      );
      await expect(page.locator('#guestbook-draft')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      const hostile = '<img src=x onerror=alert(1)> hello';
      await page.locator('#guestbook-draft').fill(hostile);
      await book.getByRole('button', { name: 'Sign' }).click();
      await expect(page.locator('#guestbook-entries li').first()).toHaveText(
        hostile,
      );
      await expect(page.locator('#guestbook-error')).toHaveCount(0);
      await expect(page.locator('#guestbook-entries img')).toHaveCount(0);
      await expect(page.locator('#guestbook-draft')).toHaveValue('');
      expect(
        await page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
      ).toBe(true);
      expect(errors).toEqual([]);
    });

    test('guestbook entries belong to one guest cookie', async ({
      page,
      browser,
    }) => {
      await open(page, base);
      const note = `private note ${platform} ${Date.now()}`;
      await page.locator('#guestbook-draft').fill(note);
      await page
        .locator('[data-nv-name="guestbook"]')
        .getByRole('button', { name: 'Sign' })
        .click();
      await expect(page.locator('#guestbook-entries')).toContainText(note);
      const other = await browser.newContext();
      try {
        const stranger = await other.newPage();
        await stranger.goto(base + '/');
        await expect(stranger.locator('#guestbook-empty')).toBeVisible();
        await expect(stranger.locator('#guestbook-entries')).not.toContainText(
          note,
        );
      } finally {
        await other.close();
      }
    });

    test('Live endpoints reject missing CSRF, forged cookies and foreign snapshots', async ({
      page,
      playwright,
    }) => {
      await open(page, base);
      const { snapshot, csrf } = await component(page, 'counter');
      expect(csrf.length).toBeGreaterThanOrEqual(32);
      const endpoint = `${base}/_nestvexa/live/counter/increment`;
      const headers = { origin: base, 'content-type': 'application/json' };
      // Same browser cookies, no CSRF header.
      const noCsrf = await page.request.post(endpoint, {
        headers,
        data: livePayload(snapshot),
      });
      expect(noCsrf.status()).toBe(403);
      // Wrong origin with valid CSRF.
      const crossOrigin = await page.request.post(endpoint, {
        headers: {
          ...headers,
          origin: 'http://evil.example',
          'x-nestvexa-csrf': csrf,
        },
        data: livePayload(snapshot),
      });
      expect(crossOrigin.status()).toBe(403);
      // A tampered cookie signature is no identity at all.
      const forged = await playwright.request.newContext({
        extraHTTPHeaders: {
          cookie: 'nv_guest=AAAAAAAAAAAAAAAAAAAAAA.forged-signature',
        },
      });
      try {
        const response = await forged.post(endpoint, {
          headers: { ...headers, 'x-nestvexa-csrf': csrf },
          data: livePayload(snapshot),
        });
        expect(response.status()).toBe(401);
      } finally {
        await forged.dispose();
      }
      // Another guest with its own valid cookie and CSRF cannot replay this snapshot.
      const stranger = await playwright.request.newContext();
      try {
        const html = await (await stranger.get(base + '/')).text();
        const strangerCsrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1] ?? '';
        expect(strangerCsrf).not.toBe('');
        expect(strangerCsrf).not.toBe(csrf);
        const replay = await stranger.post(endpoint, {
          headers: { ...headers, 'x-nestvexa-csrf': strangerCsrf },
          data: livePayload(snapshot),
        });
        expect(replay.status()).toBe(410);
        expect(await replay.json()).toMatchObject({ code: 'INVALID_SNAPSHOT' });
      } finally {
        await stranger.dispose();
      }
      // The legitimate request still works.
      const ok = await page.request.post(endpoint, {
        headers: { ...headers, 'x-nestvexa-csrf': csrf },
        data: livePayload(snapshot),
      });
      expect(ok.ok()).toBe(true);
    });

    test('native Nest guard, pipe, interceptor and filter behave identically', async ({
      request,
    }) => {
      expect(await json(request, `${base}/api/health`)).toEqual({
        status: 200,
        body: { status: 'ok', platform },
      });
      expect(await json(request, `${base}/api/notes/1`)).toEqual({
        status: 401,
        body: {
          error: {
            status: 401,
            message: 'A valid x-api-key header is required',
          },
        },
      });
      expect(
        await json(request, `${base}/api/notes/1`, { headers: apiKey }),
      ).toEqual({
        status: 200,
        body: { data: { id: 1, text: 'Nest guards still run' }, platform },
      });
      expect(
        await json(request, `${base}/api/notes/not-a-number`, {
          headers: apiKey,
        }),
      ).toEqual({
        status: 400,
        body: {
          error: {
            status: 400,
            message: 'Validation failed (numeric string is expected)',
          },
        },
      });
      expect(
        await json(request, `${base}/api/notes/99999`, { headers: apiKey }),
      ).toEqual({
        status: 404,
        body: { error: { status: 404, message: 'Note not found' } },
      });
      const created = await json(request, `${base}/api/notes`, {
        method: 'POST',
        headers: apiKey,
        data: { text: '  from the API  ' },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        data: { text: 'from the API' },
        platform,
      });
      const rejected = await json(request, `${base}/api/notes`, {
        method: 'POST',
        headers: apiKey,
        data: { text: 'x', admin: true },
      });
      expect(rejected.status).toBe(400);
    });

    test('accessibility: home and about pages have no axe violations', async ({
      page,
    }) => {
      await open(page, base);
      // Include the validation state in the scan.
      await page
        .locator('[data-nv-name="guestbook"]')
        .getByRole('button', { name: 'Sign' })
        .click();
      await expect(page.locator('#guestbook-error')).toBeVisible();
      const home = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(home.violations).toEqual([]);
      await page.goto(base + '/about');
      const about = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(about.violations).toEqual([]);
    });
  });
}
