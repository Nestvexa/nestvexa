import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page, Request } from '@playwright/test';

// Shared flows for examples/inertia-{react,vue,svelte}: each example is a real
// Vite production build (client + SSR bundle) driven by the official
// @inertiajs/{react,vue3,svelte} 3.10.0 client against @nestvexa/inertia.

export interface FrameworkSuite {
  readonly framework: 'React' | 'Vue' | 'Svelte';
  readonly base: string;
}

interface Observed {
  readonly console: string[];
  readonly errors: string[];
}

/** Captures console errors/warnings, page errors and CSP violations. */
export async function observe(page: Page): Promise<Observed> {
  const observed: Observed = { console: [], errors: [] };
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning')
      observed.console.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => observed.errors.push(error.message));
  await page.addInitScript(() => {
    const target = window as unknown as {
      __cspViolations: string[];
      __ssrHeading?: Element;
    };
    target.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      target.__cspViolations.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
    // Grab the server-rendered heading as soon as the parser creates it, before
    // any module script runs, to prove hydration adopts (not replaces) it.
    const observer = new MutationObserver(() => {
      const heading = document.querySelector('#app h1');
      if (heading) {
        target.__ssrHeading = heading;
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  return observed;
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
}

export async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __nestvexaDocument?: string }).__nestvexaDocument =
      'same';
  });
}

export async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __nestvexaDocument?: string })
        .__nestvexaDocument === 'same',
  );
}

export function inertiaRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.headers()['x-inertia'] === 'true') seen.push(request);
  });
  return seen;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('html[data-hydrated="true"]')).toHaveCount(1);
}

export function defineFrameworkSuite({
  framework,
  base,
}: FrameworkSuite): void {
  const greeting = `Welcome to Nestvexa + ${framework}`;

  test.describe(`Inertia ${framework} example (Vite build + SSR)`, () => {
    // Full SSR + hydration flows with axe scans; generous on loaded CI hosts.
    test.describe.configure({ timeout: 90000 });
    test('server-renders page markup with nonce-bound assets before any script runs', async ({
      request,
      browser,
    }) => {
      const response = await request.get(`${base}/`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      const csp = response.headers()['content-security-policy'] ?? '';
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("'strict-dynamic'");
      expect(html).toContain('data-server-rendered="true"');
      expect(html).toMatch(new RegExp(`<h1[^>]*>${escape(greeting)}</h1>`));
      expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
      expect(html).toMatch(
        new RegExp(
          `<script type="module" src="/build/assets/[^"]+\\.js" nonce="${escape(nonce ?? '')}"></script>`,
        ),
      );
      // The page object is embedded once, with the v3 script-safe escaping.
      expect(html.match(/<script data-page="app"/g)).toHaveLength(1);
      expect(html).toContain('"url":"\\/"');
      // Without JavaScript the server markup is the whole page.
      const context = await browser.newContext({ javaScriptEnabled: false });
      const noScript = await context.newPage();
      await noScript.goto(`${base}/users`);
      await expect(
        noScript.getByRole('heading', { name: 'Users', exact: true }),
      ).toBeVisible();
      await expect(
        noScript.getByRole('link', { name: 'Ada Lovelace' }),
      ).toBeVisible();
      await context.close();
    });

    test('hydrates the server DOM without mismatch warnings or CSP violations', async ({
      page,
    }) => {
      const observed = await observe(page);
      const requests = inertiaRequests(page);
      await page.goto(`${base}/`);
      await hydrated(page);
      await expect(page.getByTestId('stats')).toHaveText(/^Users: \d+$/, {
        timeout: 15000,
      });
      const adopted = await page.evaluate(() => {
        const heading = (window as unknown as { __ssrHeading?: Element })
          .__ssrHeading;
        return (
          heading !== undefined &&
          heading.isConnected &&
          heading === document.querySelector('#app h1')
        );
      });
      expect(adopted).toBe(true);
      const deferred = requests.find(
        (request) => request.headers()['x-inertia-partial-data'] === 'stats',
      );
      expect(deferred?.headers()['x-inertia-partial-component']).toBe('Home');
      await expect(page).toHaveTitle(`Home · Nestvexa ${framework}`);
      expect(observed.errors).toEqual([]);
      expect(observed.console).toEqual([]);
      expect(await cspViolations(page)).toEqual([]);
    });

    test('navigates with links over XHR and keeps persistent nested layouts', async ({
      page,
    }) => {
      const observed = await observe(page);
      await page.goto(`${base}/`);
      await hydrated(page);
      const main = page.locator('main[data-layout-instance]');
      await expect(main).not.toHaveAttribute('data-layout-instance', 'server');
      const instance = await main.getAttribute('data-layout-instance');
      await markDocument(page);
      const requests = inertiaRequests(page);
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Users' })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Users', exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${base}/users`);
      await expect(
        page.getByRole('navigation', { name: 'Users' }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Grace Hopper' }).click();
      await expect(page.getByTestId('email')).toHaveText('grace@example.test');
      await expect(page).toHaveTitle(`Grace Hopper · Nestvexa ${framework}`);
      expect(await sameDocument(page)).toBe(true);
      expect(await main.getAttribute('data-layout-instance')).toBe(instance);
      expect(
        requests.map((request) => new URL(request.url()).pathname),
      ).toEqual(expect.arrayContaining(['/users', '/users/2']));
      await page.goBack();
      await expect(
        page.getByRole('heading', { name: 'Users', exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: greeting })).toBeVisible();
      expect(await sameDocument(page)).toBe(true);
      expect(observed.errors).toEqual([]);
      expect(observed.console).toEqual([]);
    });

    test('partial reload asks for and receives only the requested prop', async ({
      page,
    }) => {
      await page.goto(`${base}/`);
      await hydrated(page);
      await expect(page.getByTestId('stats')).toHaveText(/^Users:/, {
        timeout: 15000,
      });
      await markDocument(page);
      const visits = await page.getByTestId('visits').textContent();
      const reload = page.waitForResponse(
        (response) =>
          response.request().headers()['x-inertia-partial-data'] === 'extra',
      );
      await page.getByRole('button', { name: 'Load extra' }).click();
      const partial = await reload;
      expect(partial.request().headers()['x-inertia-partial-component']).toBe(
        'Home',
      );
      const body = (await partial.json()) as { props: Record<string, unknown> };
      expect(Object.keys(body.props).sort()).toEqual(['errors', 'extra']);
      await expect(page.getByTestId('extra')).toHaveText(
        /Loaded by a partial reload/,
      );
      await expect(page.getByTestId('visits')).toHaveText(visits ?? '');
      await expect(page.getByTestId('stats')).toHaveText(/^Users:/, {
        timeout: 15000,
      });
      expect(await sameDocument(page)).toBe(true);
    });

    test('round-trips server validation errors and shows flash after redirect', async ({
      page,
      browserName,
    }) => {
      const observed = await observe(page);
      await page.goto(`${base}/users/create`);
      await hydrated(page);
      await markDocument(page);
      const submit = page.waitForResponse(
        (response) =>
          response.url() === `${base}/users` &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Save' }).click();
      const rejected = await submit;
      expect(rejected.request().headers()['x-xsrf-token']).toBeTruthy();
      await expect(page.locator('#name-error')).toHaveText(
        'The name field is required.',
      );
      await expect(page.locator('#email-error')).toHaveText(
        'The email must be a valid email address.',
      );
      await expect(page.getByLabel('Name')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await expect(page).toHaveURL(`${base}/users/create`);
      const name = `${framework} ${browserName} ${Date.now()}`;
      await page.getByLabel('Name').fill(name);
      await page.getByLabel('Email').fill(`${browserName}@example.test`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(`${base}/users`);
      await expect(page.getByTestId('flash')).toHaveText(
        `User ${name} created`,
      );
      await expect(page.getByRole('link', { name })).toHaveCount(1);
      expect(await sameDocument(page)).toBe(true);
      // Flash is read once: the next visit does not repeat it.
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Home' })
        .click();
      await expect(page.getByRole('heading', { name: greeting })).toBeVisible();
      await expect(page.getByTestId('flash')).toHaveCount(0);
      expect(observed.errors).toEqual([]);
    });

    test('rejects unsafe requests without the XSRF header', async ({
      page,
    }) => {
      await page.goto(`${base}/users/create`);
      const status = await page.evaluate(async () => {
        const response = await fetch('/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
          body: JSON.stringify({ name: 'Forged', email: 'f@example.test' }),
        });
        return response.status;
      });
      expect(status).toBe(403);
    });

    test('performs a full page load when the asset version changes', async ({
      page,
    }) => {
      await page.goto(`${base}/`);
      await hydrated(page);
      await expect(page.getByTestId('stats')).toHaveText(/^Users:/, {
        timeout: 15000,
      });
      await markDocument(page);
      await page.evaluate(async () => {
        const token = decodeURIComponent(
          /(?:^|; )XSRF-TOKEN=([^;]+)/.exec(document.cookie)?.[1] ?? '',
        );
        await fetch('/__test/version', {
          method: 'POST',
          headers: { 'X-XSRF-TOKEN': token },
        });
      });
      const conflict = page.waitForResponse(
        (response) => response.status() === 409,
      );
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Users' })
        .click();
      expect((await conflict).headers()['x-inertia-location']).toBe('/users');
      await expect(
        page.getByRole('heading', { name: 'Users', exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${base}/users`);
      expect(await sameDocument(page)).toBe(false);
    });

    test('accessibility: SSR pages and validation errors pass axe', async ({
      page,
    }) => {
      await page.goto(`${base}/`);
      await hydrated(page);
      await expect(page.getByTestId('stats')).toHaveText(/^Users:/, {
        timeout: 15000,
      });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.goto(`${base}/users/create`);
      await hydrated(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('#name-error')).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test('a page that throws falls back from SSR to the client error boundary', async ({
      page,
      request,
    }) => {
      // SSR rejects for this page; fallback mode serves the client-rendered
      // document without leaking the error.
      const html = await (await request.get(`${base}/broken`)).text();
      expect(html).not.toContain('data-server-rendered');
      expect(html).toContain('<div id="app"></div>');
      const observed = await observe(page);
      await page.goto(`${base}/broken`);
      await expect(page.getByRole('alert')).toContainText(
        'Something went wrong',
      );
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav).toBeVisible();
      await markDocument(page);
      await nav.getByRole('link', { name: 'Home' }).click();
      await expect(page.getByRole('heading', { name: greeting })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await sameDocument(page)).toBe(true);
      expect(observed.errors).toEqual([]);
    });
  });
}
