import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  booted,
  labUrl,
  openLab,
  sameDocument,
  served,
} from './browser-lab.js';

// PROT-013 against the browser-lab server (assetVersion `lab-build-1`):
// a page built for another client version reloads on its next Live request,
// and signing out while a page is open fails the next action safely, leaks no
// state and recovers after signing in again.

const incrementUrl = '**/_nestvexa/live/lab-counter/increment';

interface Captured {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/**
 * Record every increment reply as the browser receives it. Bodies are read
 * in the route, because the client may reload the page right after a reply.
 */
async function captureIncrements(page: Page): Promise<Captured[]> {
  const replies: Captured[] = [];
  await page.route(incrementUrl, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    replies.push({
      status: response.status(),
      headers: response.headers(),
      body,
    });
    await route.fulfill({ response, body });
  });
  return replies;
}

async function errorCodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const codes: string[] = [];
    document.addEventListener('nestvexa:error', (event) => {
      const detail: unknown = (event as CustomEvent).detail;
      codes.push(String(Reflect.get(Object(detail), 'code')));
    });
    Reflect.set(window, 'nvErrorCodes', codes);
  });
}
const reportedCodes = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'nvErrorCodes') as string[]);

/**
 * Serve the first home page as a previous deploy rendered it (a cached copy
 * from before the release): same server state, older client build marker.
 */
async function servePreviousBuild(page: Page): Promise<void> {
  let first = true;
  await page.route(labUrl + '/', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (first) {
      first = false;
      expect(body).toContain('data-nv-asset-version="lab-build-1"');
      body = body.replaceAll(
        'data-nv-asset-version="lab-build-1"',
        'data-nv-asset-version="lab-build-0"',
      );
    }
    await route.fulfill({ response, body });
  });
}

test('a page from a previous client build reloads on its next Live request', async ({
  page,
}) => {
  await servePreviousBuild(page);
  const errors = await openLab(page);
  expect(await served(page)).toMatchObject({ home: 1 });
  const replies = await captureIncrements(page);
  const reloaded = page.waitForEvent('load');
  await page.locator('#increment').click();
  // The client reloads the document (default of the cancelable event)…
  await reloaded;
  expect(replies).toHaveLength(1);
  expect(replies[0]?.status).toBe(409);
  expect(replies[0]?.headers['x-nestvexa-reload']).toBe('asset-version');
  expect(JSON.parse(replies[0]?.body ?? '')).toEqual({
    statusCode: 409,
    code: 'ASSET_VERSION_MISMATCH',
  });
  await booted(page);
  expect(await sameDocument(page)).toBe(false);
  expect(await served(page)).toMatchObject({ home: 2 });
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-asset-version',
    'lab-build-1',
  );
  // …the refused action never ran, and the current build works.
  await expect(page.locator('#count')).toHaveText('0');
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  expect(replies.map((reply) => reply.status)).toEqual([409, 201]);
  expect(errors).toEqual([]);
});

test('a nestvexa:reload listener can defer the reload', async ({ page }) => {
  await servePreviousBuild(page);
  await openLab(page);
  await page.evaluate(() => {
    window.addEventListener('nestvexa:reload', (event) => {
      Reflect.set(
        window,
        'nvReloadReason',
        Reflect.get(Object((event as CustomEvent).detail), 'reason'),
      );
      event.preventDefault();
    });
  });
  const replies = await captureIncrements(page);
  await page.locator('#increment').click();
  await expect.poll(() => replies.map((reply) => reply.status)).toEqual([409]);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'nvReloadReason')))
    .toBe('asset-version');
  // The host decides when to reload: the document stays and nothing applied.
  expect(await sameDocument(page)).toBe(true);
  await expect(page.locator('#count')).toHaveText('0');
  expect(await served(page)).toMatchObject({ home: 1 });
});

test('signing out while a page is open fails the next action safely and recovers', async ({
  page,
}) => {
  const errors = await openLab(page);
  await errorCodes(page);
  const replies = await captureIncrements(page);
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  const root = page.locator('[data-nv-component]');
  const snapshot = (await root.getAttribute('data-nv-snapshot')) ?? '';
  const revision = Number(await root.getAttribute('data-nv-revision'));
  expect(snapshot).toHaveLength(43);

  // Another tab of the same browser signs out.
  const other = await page.context().newPage();
  const logout = await other.request.post(labUrl + '/logout', {
    headers: { origin: labUrl },
  });
  expect(logout.status()).toBe(201);
  await other.close();

  // The open page's next action is refused before any component code runs.
  await page.locator('#increment').click();
  await expect
    .poll(() => replies.map((reply) => reply.status))
    .toEqual([201, 401]);
  const text = replies[1]?.body ?? '';
  expect(JSON.parse(text)).toMatchObject({ statusCode: 401 });
  // No state, reference, CSRF token or identity is echoed back.
  expect(text).not.toContain(snapshot);
  expect(text).not.toContain('count');
  expect(text).not.toContain('guest-session');
  await expect.poll(() => reportedCodes(page)).toEqual(['HTTP']);
  // The DOM keeps the last authorized render; nothing was applied.
  await expect(page.locator('#count')).toHaveText('1');
  expect(await sameDocument(page)).toBe(true);

  // Signing in again (a new session) and reloading recovers with fresh state.
  await page.reload();
  await booted(page);
  await expect(page.locator('#count')).toHaveText('0');
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');

  // The signed-out page's state reference is gone for the new session too.
  const csrf = (await root.getAttribute('data-nv-csrf')) ?? '';
  const replay = await page.request.post(
    labUrl + '/_nestvexa/live/lab-counter/increment',
    {
      headers: {
        origin: labUrl,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        'x-nestvexa-asset-version': 'lab-build-1',
      },
      data: {
        protocol: 'nestvexa-live/1',
        requestId: crypto.randomUUID(),
        snapshot,
        revision,
        updates: {},
        input: null,
      },
    },
  );
  expect(replay.status()).toBe(410);
  expect(await replay.json()).toEqual({
    statusCode: 410,
    code: 'INVALID_SNAPSHOT',
  });
  await expect(page.locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});
