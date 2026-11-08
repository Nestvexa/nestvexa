import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import {
  labUrl as base,
  openLab as open,
  sameDocument,
  served,
} from './browser-lab.js';

// Live navigation against the browser-lab example (real Nest server, default
// boot module with the CSP Alpine build). Every test runs in a fresh browser
// context, so the per-session render counters start at zero.
const meta = (page: Page, name: string) =>
  page.evaluate(
    (key) =>
      document.querySelector(`meta[name="${key}"]`)?.getAttribute('content') ??
      null,
    name,
  );
/** Hold matching navigation fetches until released. */
function hold(page: Page, path: string) {
  const routes: Route[] = [];
  let resolve: () => void = () => undefined;
  const arrived = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    arrived,
    install: () =>
      page.route(base + path, (route) => {
        routes.push(route);
        resolve();
      }),
    release: async () => {
      for (const route of routes.splice(0)) await route.continue();
    },
  };
}

test('swaps same-origin pages without a reload, updating history, title and metadata', async ({
  page,
}) => {
  const errors = await open(page);
  await expect(page).toHaveTitle('Browser lab');
  expect(await meta(page, 'robots')).toBeNull();

  const request = page.waitForRequest(base + '/long');
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  const sent = await request;
  expect(sent.method()).toBe('GET');
  expect(await sent.headerValue('x-nestvexa-navigate')).toBe('1');
  await expect(page).toHaveURL(base + '/long');
  await expect(page).toHaveTitle('Long page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Long page');
  expect(await meta(page, 'description')).toBe(
    'A tall page for scroll restoration',
  );
  expect(await meta(page, 'robots')).toBe('noindex');
  // The viewport meta stays with the document shell.
  expect(await meta(page, 'viewport')).toBe(
    'width=device-width, initial-scale=1',
  );
  expect(await sameDocument(page)).toBe(true);
  // Focus moves to the new main landmark for assistive technology.
  await expect(page.locator('main')).toBeFocused();

  // The swapped page's components are live.
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');

  await page.goBack();
  await expect(page).toHaveURL(base + '/');
  await expect(page).toHaveTitle('Browser lab');
  expect(await meta(page, 'robots')).toBeNull();
  expect(await meta(page, 'description')).toBe(
    'Live navigation and runtime lab',
  );
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.goForward();
  await expect(page).toHaveURL(base + '/long');
  await expect(page).toHaveTitle('Long page');
  expect(await sameDocument(page)).toBe(true);
  // History revisits re-fetch through host routes (no snapshot replay).
  expect(await served(page)).toMatchObject({ home: 2, long: 2 });
  expect(errors).toEqual([]);
});

test('restores scroll positions on Back and Forward and honours fragments', async ({
  page,
}) => {
  await open(page, '/long');
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);
  await page.evaluate(() =>
    document.querySelector<HTMLAnchorElement>('#bottom-home')?.click(),
  );
  await expect(page).toHaveURL(base + '/');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(base + '/long');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Long page');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1500);

  // Leave /long from another position, then come Forward and Back again.
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
  await page.goForward();
  await expect(page).toHaveURL(base + '/');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(base + '/long');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);

  // A fragment target is scrolled into view after the swap.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  await page.getByRole('link', { name: 'Long section B' }).click();
  await expect(page).toHaveURL(base + '/long#section-b');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.abs(
          Math.round(
            document.getElementById('section-b')?.getBoundingClientRect().top ??
              -1,
          ),
        ),
      ),
    )
    .toBe(0);
  expect(await sameDocument(page)).toBe(true);
});

test('follows same-origin redirects, keeping the requested fragment', async ({
  page,
}) => {
  await open(page);
  // /to-long#section-b redirects to /long; the fragment carries over.
  await page.getByRole('link', { name: 'Redirect' }).click();
  await expect(page).toHaveURL(base + '/long#section-b');
  await expect(page).toHaveTitle('Long page');
  expect(await sameDocument(page)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(1000);
});

test('falls back to a full document load for incompatible or unknown routes', async ({
  page,
}) => {
  // Different asset identity (one extra stylesheet).
  await open(page);
  await page.getByRole('link', { name: 'Different assets' }).click();
  await expect(page).toHaveURL(base + '/assets-differ');
  await expect(page).toHaveTitle('Different assets');
  expect(await sameDocument(page)).toBe(false);
  // Fetched once by the navigation client, then loaded natively.
  expect((await served(page))['assets-differ']).toBe(2);

  // Different document direction.
  await open(page);
  await page.getByRole('link', { name: 'RTL' }).click();
  await expect(page).toHaveURL(base + '/rtl');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await sameDocument(page)).toBe(false);

  // Non-HTML responses are never swapped in.
  await open(page);
  await page.getByRole('link', { name: 'Plain text' }).click();
  await expect(page).toHaveURL(base + '/plain.txt');
  await expect(page.locator('body')).toContainText(
    'Plain text is never swapped into the document.',
  );
  expect(await sameDocument(page)).toBe(false);

  // Unknown routes (404) load natively and show the host's error page.
  await open(page);
  await page.getByRole('link', { name: 'Missing' }).click();
  await expect(page).toHaveURL(base + '/missing');
  expect(await sameDocument(page)).toBe(false);

  // Cross-origin links keep native browser behaviour.
  await open(page);
  const crossOrigin = base.replace('127.0.0.1', 'localhost') + '/about-x';
  await page.evaluate((href) => {
    const link = document.createElement('a');
    link.href = href;
    link.id = 'cross-origin';
    link.setAttribute('nv:navigate', '');
    link.textContent = 'Elsewhere';
    document.querySelector('nav')?.append(link);
  }, crossOrigin);
  const fetches: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['x-nestvexa-navigate']) fetches.push(request.url());
  });
  await page.locator('#cross-origin').click();
  await expect(page).toHaveURL(crossOrigin);
  expect(fetches).toEqual([]);
});

test('History traversal fallback replaces the entry instead of adding one', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await expect(page).toHaveURL(base + '/long');
  const length = await page.evaluate(() => history.length);
  // The revisited page now has a different asset identity.
  await page.route(base + '/', async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      '<link rel="stylesheet" href="/lab.css" />',
      '<link rel="stylesheet" href="/lab.css" /><link rel="stylesheet" href="/lab-extra.css" />',
    );
    await route.fulfill({ response, body: html });
  });
  await page.goBack();
  await expect(page).toHaveURL(base + '/');
  await expect(page).toHaveTitle('Browser lab');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'nvSameDocument')))
    .toBeUndefined();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goForward();
  await expect(page).toHaveURL(base + '/long');
});

test('prefetches explicitly with GET, reuses the response once and expires it', async ({
  page,
}) => {
  await page.clock.install();
  await open(page);
  const prefetch = page.getByRole('link', { name: 'Prefetch' });
  const request = page.waitForRequest(base + '/prefetch');
  await prefetch.hover();
  const sent = await request;
  expect(sent.method()).toBe('GET');
  expect(await sent.headerValue('x-nestvexa-navigate')).toBe('1');
  await expect.poll(async () => (await served(page))['prefetch']).toBe(1);
  // Hovering again while cached does not refetch.
  await page.mouse.move(0, 0);
  await prefetch.hover();
  await prefetch.click();
  await expect(page).toHaveURL(base + '/prefetch');
  await expect(page.locator('#prefetch-served')).toHaveText('1');
  expect((await served(page))['prefetch']).toBe(1);
  expect(await sameDocument(page)).toBe(true);

  // A prefetched entry is consumed once: the next visit fetches again.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  await page.getByRole('link', { name: 'Prefetch' }).click();
  await expect(page.locator('#prefetch-served')).toHaveText('2');

  // Entries expire after 10 seconds.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  await page.getByRole('link', { name: 'Prefetch' }).hover();
  await expect.poll(async () => (await served(page))['prefetch']).toBe(3);
  await page.clock.fastForward(11_000);
  await page.getByRole('link', { name: 'Prefetch' }).click();
  await expect(page.locator('#prefetch-served')).toHaveText('4');
});

test('a committed Live request invalidates prefetched documents', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('link', { name: 'Prefetch' }).hover();
  await expect.poll(async () => (await served(page))['prefetch']).toBe(1);
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.getByRole('link', { name: 'Prefetch' }).click();
  await expect(page.locator('#prefetch-served')).toHaveText('2');
  expect(await sameDocument(page)).toBe(true);
});

test('asks before leaving unsaved Live drafts and keeps them when cancelled', async ({
  page,
}) => {
  await open(page);
  await page.locator('#note').fill('unsaved draft');
  const messages: string[] = [];
  page.once('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toBe('Leave this page? Unsaved changes will be lost.');
  await expect(page).toHaveURL(base + '/');
  await expect(page.locator('#note')).toHaveValue('unsaved draft');
  expect((await served(page))['long']).toBeUndefined();

  page.once('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await expect(page).toHaveURL(base + '/long');
  expect(messages).toHaveLength(2);

  // A saved draft is no longer dirty: navigation proceeds without asking.
  await page.locator('#note').fill('saved draft');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('#saved')).toHaveText('saved draft');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  expect(messages).toHaveLength(2);
});

test('shows progress and ignores a slower earlier visit that finishes last', async ({
  page,
}) => {
  const errors = await open(page);
  const slow = hold(page, '/long');
  await slow.install();
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await slow.arrived;
  await expect(page.locator('html')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('link', { name: 'Alpine' }).click();
  await expect(page).toHaveURL(base + '/alpine');
  await expect(page).toHaveTitle('Alpine bridge');
  await expect(page.locator('html')).not.toHaveAttribute('aria-busy', 'true');
  // The superseded response arrives after the newer page was applied.
  await slow.release();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(base + '/alpine');
  await expect(page).toHaveTitle('Alpine bridge');
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('a stale prefetched response is not applied after a newer visit', async ({
  page,
}) => {
  await open(page);
  const slow = hold(page, '/prefetch');
  await slow.install();
  await page.getByRole('link', { name: 'Prefetch' }).hover();
  await slow.arrived;
  // The visit awaits the held prefetch; a newer visit supersedes it.
  await page.getByRole('link', { name: 'Prefetch' }).click();
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await expect(page).toHaveURL(base + '/long');
  await slow.release();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(base + '/long');
  await expect(page).toHaveTitle('Long page');
});
