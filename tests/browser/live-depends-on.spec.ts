import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// REAL-010 and REAL-004 in a real browser (examples/starter-live, /tags).
// `@DependsOn('orders')` and `@DependsOn('inventory')` subscribe two summary
// components to their tag channels; a write calls `LiveTags.invalidate` for
// the one tag it touched, and in another session only the dependent summary
// refreshes. The stock summary also chooses its own transport
// (`@LiveComponent({ realtime: { transport: 'polling' } })`), so the page
// holds an SSE stream for the order summary and long-polls for the stock.

// The root suite serves starter-live on 3102; local runs may override the origin.
const base =
  process.env['NESTVEXA_STARTER_LIVE_ORIGIN'] ?? 'http://127.0.0.1:3102';
const url = `${base}/tags`;

/** Live `_sync` refreshes a page sends, by component name. */
function refreshes(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const match = /\/_nestvexa\/live\/([a-z-]+)\/_sync$/.exec(request.url());
    if (match?.[1]) seen.push(match[1]);
  });
  return seen;
}

test('invalidating a data tag refreshes only the components that depend on it', async ({
  browser,
}) => {
  const writer = await browser.newContext();
  const reader = await browser.newContext();
  const alice = await writer.newPage();
  const bob = await reader.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob])
    page.on('pageerror', (error) => errors.push(error.message));
  const synced = refreshes(bob);
  // Per-component transports: SSE for the order summary, polling for stock.
  const stream = bob.waitForRequest((request) =>
    request.url().includes('/_nestvexa/realtime/sse?'),
  );
  const poll = bob.waitForRequest((request) =>
    request.url().includes('/_nestvexa/realtime/poll?'),
  );
  await alice.goto(url);
  await bob.goto(url);
  const sse = await stream;
  const longPoll = await poll;
  const orders = bob.locator('[data-nv-name="order-summary"]');
  const stock = bob.locator('[data-nv-name="stock-summary"]');
  await expect(stock).toHaveAttribute('data-nv-realtime-transport', 'polling');
  await expect(orders).not.toHaveAttribute('data-nv-realtime-transport', /.*/);
  const token = async (component: typeof orders) =>
    encodeURIComponent(
      (await component.getAttribute('data-nv-realtime')) ?? '',
    );
  // Each connection carries only its own component's subscription.
  expect(sse.url()).toContain(await token(orders));
  expect(sse.url()).not.toContain(await token(stock));
  expect(longPoll.url()).toContain(await token(stock));
  expect(longPoll.url()).not.toContain(await token(orders));
  const orderCount = Number(await bob.locator('#order-count').textContent());
  const stockCount = Number(await bob.locator('#stock-count').textContent());
  // Wait until the poll is parked on the server before writing.
  await bob.waitForTimeout(300);

  // An order invalidates `orders` only.
  await alice.getByRole('button', { name: 'Place order' }).click();
  await expect(alice.locator('#warehouse-writes')).toHaveText('1');
  await expect(bob.locator('#order-count')).toHaveText(String(orderCount + 1));
  await expect
    .poll(() => synced.filter((name) => name === 'order-summary').length)
    .toBe(1);
  // Give a wrong refresh time to happen before asserting it did not.
  await bob.waitForTimeout(500);
  expect(synced).toEqual(['order-summary']);
  await expect(bob.locator('#stock-count')).toHaveText(String(stockCount));

  // Restocking invalidates `inventory` only, delivered by long polling.
  await alice.getByRole('button', { name: 'Restock' }).click();
  await expect(alice.locator('#warehouse-writes')).toHaveText('2');
  await expect(bob.locator('#stock-count')).toHaveText(String(stockCount + 5));
  await bob.waitForTimeout(500);
  expect(synced).toEqual(['order-summary', 'stock-summary']);
  await expect(bob.locator('#order-count')).toHaveText(String(orderCount + 1));
  // The writer's controls never subscribe; Bob's refreshes kept the revision.
  await expect(
    bob.locator('[data-nv-name="warehouse-controls"]'),
  ).not.toHaveAttribute('data-nv-realtime', /.*/);
  await expect(orders).toHaveAttribute('data-nv-revision', '0');
  await expect(stock).toHaveAttribute('data-nv-revision', '0');
  expect(errors).toEqual([]);
  await writer.close();
  await reader.close();
});
