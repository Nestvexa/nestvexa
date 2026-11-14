import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * EXT-005: deferred island strategies in examples/hybrid-dashboard, asserted
 * on the network. `activity-feed` (Vue) is `visible` and `status-widget`
 * (Svelte) is `idle`; each loads its own manifest entry chunk, so "the chunk
 * was requested" is the observable for "the strategy fired". Nothing here waits
 * a fixed time: the idle callback is held by a stub, and the fallback timer is
 * driven by Playwright's fake clock.
 */
const base = process.env['NESTVEXA_HYBRID_URL'] ?? 'http://127.0.0.1:3112';
const url = `${base}/hybrid`;
const feedChunk = /^\/islands\/vue-feed-[A-Z0-9]{8}\.js$/;
const widgetChunk = /^\/islands\/svelte-widget-[A-Z0-9]{8}\.js$/;

function chunkRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/islands/')) seen.push(path);
  });
  return seen;
}

async function state(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate(
    (target) =>
      (
        window as unknown as {
          nvIslands?: {
            diagnostics(): { id: string; state: string }[];
          };
        }
      ).nvIslands
        ?.diagnostics()
        .find((entry) => entry.id === target)?.state,
    id,
  );
}

/** The loader has started and the immediate islands are mounted. */
async function loaderSettled(page: Page): Promise<void> {
  await expect(page.locator('#chart-title')).toHaveText('Revenue by quarter');
  await expect.poll(() => state(page, 'revenue-chart')).toBe('mounted');
}

test('a visible island requests its code only after it scrolls into view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  const requests = chunkRequests(page);
  await page.goto(url);
  await loaderSettled(page);
  const feed = page.locator('[data-nv-island="activity-feed"]');
  // Precondition: the island starts below the fold.
  const box = await feed.boundingBox();
  expect(box?.y ?? 0).toBeGreaterThan(360);
  expect(await state(page, 'activity-feed')).toBe('scheduled');
  expect(requests.some((path) => feedChunk.test(path))).toBe(false);

  const loaded = page.waitForRequest((request) =>
    feedChunk.test(new URL(request.url()).pathname),
  );
  await feed.scrollIntoViewIfNeeded();
  await loaded;
  await expect(page.locator('#feed-items li').first()).toHaveText(
    'Dashboard opened',
  );
  await expect.poll(() => state(page, 'activity-feed')).toBe('mounted');
  expect(requests.filter((path) => feedChunk.test(path))).toHaveLength(1);
});

test('an idle island waits for requestIdleCallback, with a 2 s timeout', async ({
  page,
}) => {
  // Hold the loader's idle callback (the only one registered with a 2000 ms
  // timeout); every other caller keeps the browser's behaviour.
  await page.addInitScript(() => {
    const held: { run: () => void; timeout: number | undefined }[] = [];
    const original: unknown = Reflect.get(window, 'requestIdleCallback');
    const native =
      typeof original === 'function'
        ? (original as typeof window.requestIdleCallback).bind(window)
        : undefined;
    const fallback = (callback: IdleRequestCallback): number =>
      window.setTimeout(() =>
        callback({ didTimeout: false, timeRemaining: () => 0 }),
      );
    Object.assign(window, {
      nvHeldIdle: held,
      requestIdleCallback(
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ): number {
        if (options?.timeout !== 2000)
          return native ? native(callback, options) : fallback(callback);
        held.push({
          run: () => callback({ didTimeout: false, timeRemaining: () => 50 }),
          timeout: options.timeout,
        });
        return 100_000 + held.length;
      },
      cancelIdleCallback(handle: number): void {
        if (handle <= 100_000) window.clearTimeout(handle);
      },
    });
  });
  const requests = chunkRequests(page);
  await page.goto(url);
  await loaderSettled(page);
  const held = () =>
    page.evaluate(
      () =>
        (window as unknown as { nvHeldIdle: { timeout: number }[] }).nvHeldIdle
          .length,
    );
  await expect.poll(held).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nvHeldIdle: { timeout: number }[] })
          .nvHeldIdle[0]?.timeout,
    ),
  ).toBe(2000);
  expect(await state(page, 'status-widget')).toBe('scheduled');
  expect(requests.some((path) => widgetChunk.test(path))).toBe(false);

  const loaded = page.waitForRequest((request) =>
    widgetChunk.test(new URL(request.url()).pathname),
  );
  await page.evaluate(() => {
    for (const entry of (window as unknown as { nvHeldIdle: { run(): void }[] })
      .nvHeldIdle)
      entry.run();
  });
  await loaded;
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
  await expect.poll(() => state(page, 'status-widget')).toBe('mounted');
});

test('without requestIdleCallback an idle island loads on its 200 ms fallback timer', async ({
  page,
}) => {
  // Safari path. The fake clock is paused before the page loads, so the
  // fallback timer fires exactly when the test advances time.
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
  });
  const requests = chunkRequests(page);
  await page.goto(url);
  await loaderSettled(page);
  expect(await state(page, 'status-widget')).toBe('scheduled');
  await page.clock.runFor(150);
  expect(await state(page, 'status-widget')).toBe('scheduled');
  expect(requests.some((path) => widgetChunk.test(path))).toBe(false);

  const loaded = page.waitForRequest((request) =>
    widgetChunk.test(new URL(request.url()).pathname),
  );
  await page.clock.runFor(60);
  await loaded;
  await expect(page.locator('#widget-status')).toHaveText('Sync: online');
});
