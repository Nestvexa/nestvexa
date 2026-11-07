import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import { labUrl, openLab, sameDocument } from './browser-lab.js';

// Network reorder, stale replies, tab visibility, connectivity loss/recovery
// and the progressive full-page fallback, against the browser-lab server.

const live = (component: string, action: string) =>
  `**/_nestvexa/live/${component}/${action}`;

function liveRequests(page: Page, action: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/${action}`) && request.method() === 'POST')
      seen.push(request);
  });
  return seen;
}
async function errorCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const codes: string[] = [];
    document.addEventListener('nestvexa:error', (event) => {
      const detail: unknown = (event as CustomEvent).detail;
      codes.push(String(Reflect.get(Object(detail), 'code')));
    });
    Reflect.set(window, 'nvErrorCodes', codes);
    return codes;
  });
}
const reportedCodes = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'nvErrorCodes') as string[]);

test('a stale reply delivered after a newer one is rejected, not applied', async ({
  page,
}) => {
  const errors = await openLab(page);
  await errorCodes(page);
  // Capture the authentic reply to the first increment (count 0 -> 1).
  let first: string | undefined;
  await page.route(live('lab-counter', 'increment'), async (route) => {
    const response = await route.fetch();
    first ??= await response.text();
    await route.fulfill({ response });
  });
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('2');
  expect(first).toContain('"revision"');

  // A reordering proxy now delivers the old reply for the newest request.
  await page.unroute(live('lab-counter', 'increment'));
  await page.route(live('lab-counter', 'increment'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: first ?? '',
    }),
  );
  await page.locator('#increment').click();
  await expect.poll(() => reportedCodes(page)).toEqual(['RESPONSE']);
  // The stale count (1) never replaced the newer state (2).
  await expect(page.locator('#count')).toHaveText('2');
  // The component suspends instead of guessing; the reload affordance shows.
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-suspended',
    '',
  );
  await expect(page.locator('.reload-hint')).toBeVisible();
  await page.getByRole('link', { name: 'Reload the page' }).click();
  await expect(page.locator('.reload-hint')).toBeHidden();
  expect(await sameDocument(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('requests of one component are serialized, so replies cannot reorder', async ({
  page,
}) => {
  await openLab(page);
  const held: Route[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route(live('lab-counter', 'increment'), async (route) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (held.length === 0) {
      held.push(route);
      return;
    }
    await route.continue();
    inFlight--;
  });
  await page.locator('#increment').click();
  await expect.poll(() => held.length).toBe(1);
  await page.locator('#increment').click();
  await page.locator('#increment').click();
  await page.waitForTimeout(300);
  // Later clicks wait behind the held request instead of racing it.
  expect(inFlight).toBe(1);
  await held[0]?.continue();
  inFlight--;
  await expect(page.locator('#count')).toHaveText('3');
  expect(maxInFlight).toBe(1);
});

test('independent components apply their own replies in any arrival order', async ({
  page,
}) => {
  await openLab(page, '/many?count=2');
  const cells = page.locator('.cell');
  let hold: Route | undefined;
  await page.route(live('lab-cell', 'hit'), async (route) => {
    if (!hold) {
      hold = route;
      return;
    }
    await route.continue();
  });
  await cells.nth(0).locator('.cell-hit').click();
  await expect.poll(() => hold !== undefined).toBe(true);
  await cells.nth(1).locator('.cell-hit').click();
  await expect(cells.nth(1).locator('.cell-hits')).toHaveText('1');
  await expect(cells.nth(0).locator('.cell-hits')).toHaveText('0');
  await hold?.continue();
  await expect(cells.nth(0).locator('.cell-hits')).toHaveText('1');
  await expect(cells.nth(1).locator('.cell-hits')).toHaveText('1');
  // Alpine reads follow each owner's committed state.
  await expect(cells.nth(0).locator('.cell-alpine')).toHaveText('1');
  await expect(cells.nth(1).locator('.cell-alpine')).toHaveText('1');
});

test('a late reply for a component removed by navigation is discarded', async ({
  page,
}) => {
  const errors = await openLab(page);
  await errorCodes(page);
  let hold: Route | undefined;
  await page.route(live('lab-counter', 'increment'), (route) => {
    hold = route;
  });
  await page.locator('#increment').click();
  await expect.poll(() => hold !== undefined).toBe(true);
  await page.getByRole('link', { name: 'Long', exact: true }).click();
  await expect(page).toHaveTitle('Long page');
  await hold?.continue();
  await page.waitForTimeout(500);
  await expect(page.locator('#count')).toHaveText('0');
  expect(await reportedCodes(page)).toEqual([]);
  // The new page's component is unaffected and usable.
  await page.unroute(live('lab-counter', 'increment'));
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

/** Emulate a background tab: the same signals browsers send on tab switches. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    if (value)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
    else Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('polling pauses in a hidden tab and resumes when it becomes visible', async ({
  page,
}) => {
  await openLab(page, '/ticker');
  const ticks = liveRequests(page, 'tick');
  await expect.poll(() => ticks.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await setHidden(page, true);
  await page.waitForTimeout(300);
  const paused = ticks.length;
  await page.waitForTimeout(2500);
  expect(ticks.length).toBe(paused);
  await setHidden(page, false);
  await expect
    .poll(() => ticks.length, { timeout: 10_000 })
    .toBeGreaterThan(paused);
  const shown = Number(await page.locator('#ticks').textContent());
  await expect
    .poll(async () => Number(await page.locator('#ticks').textContent()))
    .toBeGreaterThan(shown);
});

test('network loss shows offline state, sends nothing and recovers cleanly', async ({
  page,
  context,
}) => {
  const errors = await openLab(page, '/ticker');
  const ticks = liveRequests(page, 'tick');
  const clicks = liveRequests(page, 'click');
  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect.poll(() => ticks.length, { timeout: 10_000 }).toBeGreaterThan(0);

  await context.setOffline(true);
  await expect(page.locator('#offline-banner')).toBeVisible();
  await page.waitForTimeout(300);
  const before = ticks.length;
  // An action while offline is refused locally and never reaches the network.
  await page.locator('#click').click();
  await page.waitForTimeout(2500);
  expect(ticks.length).toBe(before);
  expect(clicks).toHaveLength(0);
  await expect(page.locator('[data-nv-component]')).not.toHaveAttribute(
    'data-nv-suspended',
  );

  await context.setOffline(false);
  await expect(page.locator('#offline-banner')).toBeHidden();
  await expect
    .poll(() => ticks.length, { timeout: 10_000 })
    .toBeGreaterThan(before);
  // The component stayed usable: the next action commits normally.
  await page.locator('#click').click();
  await expect(page.locator('#clicks')).toHaveText('1');
  expect(clicks).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a committed $sync whose reply was lost is reconciled by one resync on STALE_REVISION', async ({
  page,
}) => {
  const errors = await openLab(page);
  await errorCodes(page);
  // A proxy drops the reply after the server committed the synchronization.
  let dropped = false;
  await page.route(live('lab-counter', '_sync'), async (route) => {
    if (dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  const syncs = liveRequests(page, '_sync');
  const increments = liveRequests(page, 'increment');
  await page.locator('#echo').fill('committed once');
  await expect.poll(() => reportedCodes(page)).toEqual(['NETWORK']);
  // A $sync without a reply leaves the component usable but one revision behind.
  await expect(page.locator('#echo-server')).toHaveText('');

  // The next action carries the old revision: the server refuses it with
  // STALE_REVISION and the resync hint, and the client resyncs once.
  await page.locator('#increment').click();
  await expect.poll(() => reportedCodes(page)).toEqual(['NETWORK', 'HTTP']);
  await expect(page.locator('#echo-server')).toHaveText('committed once');
  await expect(page.locator('[data-nv-component]')).not.toHaveAttribute(
    'data-nv-suspended',
  );
  expect(
    syncs.map((request) => request.headers()['x-nestvexa-resync']),
  ).toEqual([undefined, '1']);
  // The refused increment is not replayed; the user repeats the intent.
  await expect(page.locator('#count')).toHaveText('0');
  expect(increments).toHaveLength(1);
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  expect(increments).toHaveLength(2);
  expect(syncs).toHaveLength(2);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('a failed Live request suspends the component and its no-JS form takes over without a resend', async ({
  page,
}) => {
  const errors = await openLab(page);
  await errorCodes(page);
  const saves = liveRequests(page, 'save');
  // The connection drops after the request left: the action may have run.
  await page.route(live('lab-counter', 'save'), (route) =>
    route.abort('failed'),
  );
  await page.locator('#note').fill('kept by the host');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect.poll(() => reportedCodes(page)).toEqual(['NETWORK']);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-suspended',
    '',
  );
  await expect(page.locator('.reload-hint')).toBeVisible();
  // Never resent automatically (save is not declared idempotent).
  await page.waitForTimeout(1000);
  expect(saves).toHaveLength(1);
  // Other Live interactions on the suspended component send nothing.
  await page.locator('#increment').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#count')).toHaveText('0');

  // The next submission is a fresh, user-initiated full-page POST to the
  // form's host route (its no-JS equivalent), not a replay of the Live call.
  const post = page.waitForRequest(
    (request) =>
      request.url() === labUrl + '/note' && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save note' }).click();
  expect((await post).postData()).toBe('note=kept+by+the+host');
  await expect(page.locator('#host-note')).toHaveText('kept by the host');
  expect(await sameDocument(page)).toBe(false);
  expect(saves).toHaveLength(1);
  // The reloaded page has a fresh, working component.
  await expect(page.locator('.reload-hint')).toBeHidden();
  await page.locator('#increment').click();
  await expect(page.locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('a healthy component keeps native form submission disabled', async ({
  page,
}) => {
  await openLab(page);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.url() === labUrl + '/note') posts.push(request.method());
  });
  await page.locator('#note').fill('live save');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('#saved')).toHaveText('live save');
  expect(posts).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
});
