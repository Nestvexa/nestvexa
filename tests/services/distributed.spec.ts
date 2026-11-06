import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/*
 * Two Nest replicas behind a proxy, sharing Redis for realtime pub/sub
 * (RedisRealtimeBroker) and Live state (RedisLiveStore). The `nv_replica`
 * cookie pins a browser to replica a (SSE) or b (WebSocket).
 */
const proxy = 'http://127.0.0.1:3222';

async function pinned(
  browser: Browser,
  replica: 'a' | 'b',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await pin(context, replica);
  return { context, page: await context.newPage() };
}
async function pin(context: BrowserContext, replica: 'a' | 'b') {
  await context.addCookies([
    { name: 'nv_replica', value: replica, url: proxy },
  ]);
}
/** Resolves with the socket URL once the server acknowledged the subscription. */
function websocketReady(page: Page): Promise<string> {
  return new Promise((resolve) => {
    page.on('websocket', (socket) => {
      // Listen from the first frame: the ready notice can arrive immediately.
      socket.on('framereceived', (frame) => {
        if (String(frame.payload).includes('"ready"')) resolve(socket.url());
      });
    });
  });
}
const increment = (page: Page) =>
  page.getByRole('button', { name: 'Increment shared total' }).click();
const total = async (page: Page) =>
  Number(await page.locator('#total').textContent());

test('an event published on replica B refreshes a browser subscribed through replica A, and back', async ({
  browser,
}) => {
  const onA = await pinned(browser, 'a');
  const onB = await pinned(browser, 'b');
  const errors: string[] = [];
  for (const page of [onA.page, onB.page])
    page.on('pageerror', (error) => errors.push(error.message));
  const stream = onA.page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  const socket = websocketReady(onB.page);
  await onA.page.goto(proxy);
  await onB.page.goto(proxy);
  await expect(onA.page.locator('#rendered-by')).toHaveText('a');
  await expect(onB.page.locator('#rendered-by')).toHaveText('b');
  // A's browser holds its SSE stream on replica a; B's a WebSocket on b.
  const sse = await stream;
  expect(sse.status()).toBe(200);
  expect(sse.headers()['x-nestvexa-replica']).toBe('a');
  expect(await socket).toBe('ws://127.0.0.1:3222/_nestvexa/realtime/ws');
  const start = await total(onA.page);
  await increment(onB.page);
  await expect(onB.page.locator('#total')).toHaveText(String(start + 1));
  // Published on b, delivered through Redis to a, refreshed by a's $sync.
  await expect(onA.page.locator('#total')).toHaveText(String(start + 1));
  await expect(onA.page.locator('#rendered-by')).toHaveText('a');
  await expect(onA.page.locator('#clicks')).toHaveText('0');
  await increment(onA.page);
  await expect(onB.page.locator('#total')).toHaveText(String(start + 2));
  expect(errors).toEqual([]);
  await onA.context.close();
  await onB.context.close();
});

test('a Live component whose state was created on replica A continues on replica B', async ({
  browser,
}) => {
  const { context, page } = await pinned(browser, 'a');
  await page.goto(proxy);
  await increment(page);
  await expect(page.locator('#clicks')).toHaveText('1');
  await expect(page.locator('#rendered-by')).toHaveText('a');
  // The load balancer moves this browser: the next action lands on b, which
  // reads the snapshot replica a stored in Redis and commits revision 2.
  await pin(context, 'b');
  const action = page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/live/replica-board/increment'),
  );
  await increment(page);
  const response = await action;
  expect(response.status()).toBe(201);
  expect(response.headers()['x-nestvexa-replica']).toBe('b');
  await expect(page.locator('#clicks')).toHaveText('2');
  await expect(page.locator('#rendered-by')).toHaveText('b');
  // Replaying that revision-1 request on the other replica is a conflict.
  const sent = response.request();
  const headers = sent.headers();
  await pin(context, 'a');
  const replay = await page.request.post(
    `${proxy}/_nestvexa/live/replica-board/increment`,
    {
      headers: {
        origin: proxy,
        'content-type': 'application/json',
        'x-nestvexa-csrf': headers['x-nestvexa-csrf'] ?? '',
      },
      data: sent.postData() ?? '',
    },
  );
  expect(replay.headers()['x-nestvexa-replica']).toBe('a');
  expect(replay.status()).toBe(409);
  await expect(page.locator('#clicks')).toHaveText('2');
  await context.close();
});

test('another identity cannot use a subscription or Live state on any replica', async ({
  browser,
}) => {
  const owner = await pinned(browser, 'a');
  await owner.page.goto(proxy);
  const root = owner.page.locator('[data-nv-name="replica-board"]');
  const token = (await root.getAttribute('data-nv-realtime')) ?? '';
  const snapshot = (await root.getAttribute('data-nv-snapshot')) ?? '';
  const csrf = (await root.getAttribute('data-nv-csrf')) ?? '';
  expect(token).toMatch(/\./);
  for (const replica of ['a', 'b'] as const) {
    const intruder = await pinned(browser, replica);
    await intruder.page.goto(proxy);
    const stolen = await intruder.page.request.get(
      `${proxy}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
    );
    expect(stolen.status(), `subscription via ${replica}`).toBe(403);
    const action = await intruder.page.request.post(
      `${proxy}/_nestvexa/live/replica-board/increment`,
      {
        headers: {
          origin: proxy,
          'content-type': 'application/json',
          'x-nestvexa-csrf': csrf,
        },
        data: {
          protocol: 'nestvexa-live/1',
          requestId: crypto.randomUUID(),
          snapshot,
          revision: 0,
          updates: {},
          input: null,
        },
      },
    );
    // The CSRF token is the owner's; with the intruder's own session the
    // request is refused before state is touched.
    expect([403, 410], `live action via ${replica}`).toContain(action.status());
    await intruder.context.close();
  }
  // A forged identity cookie is not accepted by either replica.
  const forged = await browser.newContext();
  await forged.addCookies([
    {
      name: 'nv_guest',
      value: `${'A'.repeat(22)}.${'B'.repeat(43)}`,
      url: proxy,
    },
    { name: 'nv_replica', value: 'b', url: proxy },
  ]);
  const poll = await forged.request.get(
    `${proxy}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
  );
  expect(poll.status()).toBe(401);
  await forged.close();
  await expect(owner.page.locator('#clicks')).toHaveText('0');
  await owner.context.close();
});
