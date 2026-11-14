import { expect, test } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/*
 * Four Nest replicas behind a proxy, sharing Redis for realtime pub/sub
 * (RedisRealtimeBroker), Live state (RedisLiveStore) and presence
 * (RedisPresenceStore). The `nv_replica` cookie pins a browser to replica
 * a (Express, SSE), b (Express, WebSocket), c (Fastify, SSE) or d (Fastify,
 * WebSocket). Ports follow playwright.services.config.ts.
 */
type Replica = 'a' | 'b' | 'c' | 'd';
const base = Number(process.env['NESTVEXA_ACCEPT_BASE_PORT'] ?? 3220);
const direct: Record<Replica, string> = {
  a: `http://127.0.0.1:${base}`,
  b: `http://127.0.0.1:${base + 1}`,
  c: `http://127.0.0.1:${base + 3}`,
  d: `http://127.0.0.1:${base + 4}`,
};
const proxy = `http://127.0.0.1:${base + 2}`;
const proxySocket = `${proxy.replace('http', 'ws')}/_nestvexa/realtime/ws`;

async function pinned(
  browser: Browser,
  replica: Replica,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await pin(context, replica);
  return { context, page: await context.newPage() };
}
async function pin(context: BrowserContext, replica: Replica) {
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
  expect(await socket).toBe(proxySocket);
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
  // The client is mounted once its realtime stream is open; a click before
  // that would be a plain button press.
  const mountedClient = sseOpened(page);
  await page.goto(proxy);
  await mountedClient;
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

/** SSE stream response for a page, pinned replica asserted by the caller. */
function sseOpened(page: Page) {
  return page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
}
/** Record every realtime event id a page receives (to detect duplicates). */
async function recordEvents(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, '__nvEvents', seen);
    window.addEventListener('nestvexa:realtime', (event) => {
      const detail: unknown = Reflect.get(event, 'detail');
      const id: unknown =
        detail && typeof detail === 'object'
          ? Reflect.get(detail, 'id')
          : undefined;
      if (typeof id === 'string') seen.push(id);
    });
  });
  return () =>
    page.evaluate(() => [...(Reflect.get(window, '__nvEvents') as string[])]);
}
async function connections(replica: Replica, page: Page): Promise<number> {
  const response = await page.request.get(`${direct[replica]}/api/health`);
  return Number((await response.json()).connections);
}

test('Fastify and Express replicas serve the same app: events, Live state and transports cross adapters', async ({
  browser,
}) => {
  const onA = await pinned(browser, 'a');
  const onC = await pinned(browser, 'c');
  const onD = await pinned(browser, 'd');
  const streamA = sseOpened(onA.page);
  const stream = sseOpened(onC.page);
  const socket = websocketReady(onD.page);
  for (const { page } of [onA, onC, onD]) await page.goto(proxy);
  // Every client is mounted (its realtime connection is open) before acting.
  await streamA;
  await expect(onA.page.locator('#http-adapter')).toHaveText('express');
  await expect(onC.page.locator('#http-adapter')).toHaveText('fastify');
  await expect(onD.page.locator('#http-adapter')).toHaveText('fastify');
  // c holds an SSE stream on Fastify; d a WebSocket on Fastify.
  const sse = await stream;
  expect(sse.status()).toBe(200);
  expect(sse.headers()['x-nestvexa-replica']).toBe('c');
  expect(await socket).toBe(proxySocket);
  // Published on Express a, delivered through Redis to both Fastify replicas.
  const start = await total(onA.page);
  await increment(onA.page);
  await expect(onC.page.locator('#total')).toHaveText(String(start + 1));
  await expect(onD.page.locator('#total')).toHaveText(String(start + 1));
  await expect(onC.page.locator('#rendered-by')).toHaveText('c');
  // ...and back from Fastify d to Express a.
  await increment(onD.page);
  await expect(onA.page.locator('#total')).toHaveText(String(start + 2));
  // Live state created on Express a continues on Fastify c.
  await expect(onA.page.locator('#clicks')).toHaveText('1');
  await pin(onA.context, 'c');
  await increment(onA.page);
  await expect(onA.page.locator('#clicks')).toHaveText('2');
  await expect(onA.page.locator('#rendered-by')).toHaveText('c');
  for (const { context } of [onA, onC, onD]) await context.close();
});

test('presence counts viewers on every replica and releases them when browsers leave', async ({
  browser,
}) => {
  const sessions = await Promise.all(
    (['a', 'b', 'c', 'd'] as const).map((replica) => pinned(browser, replica)),
  );
  for (const { page } of sessions) await page.goto(proxy);
  const observer = sessions[0]?.page;
  if (!observer) throw new Error('no observer');
  // Each replica holds one connection; only shared presence can see four.
  await expect(async () => {
    await increment(observer);
    await expect(observer.locator('#viewers')).toHaveText('4', {
      timeout: 1500,
    });
  }).toPass({ timeout: 30_000 });
  for (const replica of ['a', 'b', 'c', 'd'] as const)
    expect(await connections(replica, observer)).toBe(1);
  // Three browsers leave: their replicas remove the entries promptly.
  for (const session of sessions.slice(1)) await session.context.close();
  await expect(async () => {
    await increment(observer);
    await expect(observer.locator('#viewers')).toHaveText('1', {
      timeout: 1500,
    });
  }).toPass({ timeout: 30_000 });
  await sessions[0]?.context.close();
});

test('browsers reconnect after the load balancer drops them, without duplicates or leaked subscriptions', async ({
  browser,
}) => {
  const onA = await pinned(browser, 'a');
  const onD = await pinned(browser, 'd');
  const eventsA = await recordEvents(onA.page);
  const eventsD = await recordEvents(onD.page);
  const firstStream = sseOpened(onA.page);
  const firstSocket = websocketReady(onD.page);
  await onA.page.goto(proxy);
  await onD.page.goto(proxy);
  await firstStream;
  await firstSocket;
  const start = await total(onA.page);
  // Both pages refresh on the event. Let those refreshes finish first: a drop
  // that cuts a committed `$sync` lets the browser resend it on a new
  // connection, which the server refuses as a stale revision. The board reads
  // the shared total through an async computed value, so every refresh is
  // read-only: marked `x-nestvexa-resync: 1`, answered 201 (never
  // `409 REFRESH_CONFLICT`), and the revision does not move.
  const board = onA.page.locator('[data-nv-name="replica-board"]');
  const revisionA = Number(await board.getAttribute('data-nv-revision'));
  const refreshes: { status: number; resync: string | undefined }[] = [];
  for (const page of [onA.page, onD.page])
    page.on('response', (response) => {
      if (response.url().includes('/_nestvexa/live/replica-board/_sync'))
        refreshes.push({
          status: response.status(),
          resync: response.request().headers()['x-nestvexa-resync'],
        });
    });
  const synced = [onA.page, onD.page].map((page) =>
    page.waitForResponse((response) =>
      response.url().includes('/_nestvexa/live/replica-board/_sync'),
    ),
  );
  await increment(onD.page);
  await expect(onA.page.locator('#total')).toHaveText(String(start + 1));
  const [refreshA] = await Promise.all(synced);
  expect(await refreshA?.json()).toMatchObject({
    component: { revision: revisionA },
  });
  await expect(board).toHaveAttribute('data-nv-revision', String(revisionA));
  expect(refreshes.length).toBeGreaterThanOrEqual(2);
  for (const refresh of refreshes)
    expect(refresh, JSON.stringify(refresh)).toEqual({
      status: 201,
      resync: '1',
    });
  // Every open connection is cut, like a load balancer restart.
  const reconnectedStream = sseOpened(onA.page);
  const reconnectedSocket = websocketReady(onD.page);
  const dropped = await onA.page.request.post(`${proxy}/__proxy/drop`);
  expect((await dropped.json()).dropped).toBeGreaterThan(0);
  await reconnectedStream;
  await reconnectedSocket;
  // After reconnecting both browsers receive new events again.
  await increment(onA.page);
  await expect(onD.page.locator('#total')).toHaveText(String(start + 2));
  await increment(onD.page);
  await expect(onA.page.locator('#total')).toHaveText(String(start + 3));
  // No event id was delivered twice to either page.
  for (const read of [eventsA, eventsD]) {
    const ids = await read();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  }
  // One connection per browser after reconnecting; none once they leave.
  expect(await connections('a', onA.page)).toBe(1);
  expect(await connections('d', onA.page)).toBe(1);
  const probe = await browser.newContext();
  await onA.context.close();
  await onD.context.close();
  await expect(async () => {
    for (const replica of ['a', 'b', 'c', 'd'] as const)
      expect(
        Number(
          (
            await (
              await probe.request.get(`${direct[replica]}/api/health`)
            ).json()
          ).connections,
        ),
      ).toBe(0);
  }).toPass({ timeout: 30_000 });
  await probe.close();
});

/** Mount the board on `replica` and read the envelope fields a browser would send. */
async function mounted(page: Page) {
  await page.goto(proxy);
  const root = page.locator('[data-nv-name="replica-board"]');
  return {
    snapshot: (await root.getAttribute('data-nv-snapshot')) ?? '',
    csrf: (await root.getAttribute('data-nv-csrf')) ?? '',
  };
}
function action(
  page: Page,
  name: string,
  fields: { snapshot: string; csrf: string },
  requestId: string,
) {
  return page.request.post(`${proxy}/_nestvexa/live/replica-board/${name}`, {
    headers: {
      origin: proxy,
      'content-type': 'application/json',
      'x-nestvexa-csrf': fields.csrf,
    },
    data: {
      protocol: 'nestvexa-live/1',
      requestId,
      snapshot: fields.snapshot,
      revision: 0,
      updates: {},
      input: null,
    },
  });
}
async function charges(page: Page): Promise<number> {
  const response = await page.request.get(`${direct.a}/api/charges`);
  return Number((await response.json()).charges);
}

test('an idempotent retry replays on another replica (Express → Fastify) without repeating the side effect', async ({
  browser,
}) => {
  const { context, page } = await pinned(browser, 'a');
  const fields = await mounted(page);
  const before = await charges(page);
  const requestId = crypto.randomUUID();
  const first = await action(page, 'pay', fields, requestId);
  expect(first.status()).toBe(201);
  expect(first.headers()['x-nestvexa-replica']).toBe('a');
  const firstBody = await first.json();
  expect(firstBody.replayed).toBeUndefined();
  expect(await charges(page)).toBe(before + 1);
  // The response was lost; the browser retries and lands on Fastify c.
  await pin(context, 'c');
  const retry = await action(page, 'pay', fields, requestId);
  expect(retry.status()).toBe(201);
  expect(retry.headers()['x-nestvexa-replica']).toBe('c');
  const retryBody = await retry.json();
  expect(retryBody).toMatchObject({
    replayed: true,
    snapshot: firstBody.snapshot,
    html: firstBody.html,
  });
  expect(await charges(page)).toBe(before + 1);
  // Reusing the request ID for a different request is refused on any replica.
  await pin(context, 'd');
  const reused = await page.request.post(
    `${proxy}/_nestvexa/live/replica-board/pay`,
    {
      headers: {
        origin: proxy,
        'content-type': 'application/json',
        'x-nestvexa-csrf': fields.csrf,
      },
      data: {
        protocol: 'nestvexa-live/1',
        requestId,
        snapshot: firstBody.snapshot,
        revision: 1,
        updates: {},
        input: null,
      },
    },
  );
  expect(reused.status()).toBe(422);
  expect(await charges(page)).toBe(before + 1);
  await context.close();
});

test('an identity-scoped action holds one lock across replicas and releases it', async ({
  browser,
}) => {
  const owner = await pinned(browser, 'a');
  const firstTab = await mounted(owner.page);
  const secondTab = await mounted(owner.page);
  const running = action(
    owner.page,
    'exportAll',
    firstTab,
    crypto.randomUUID(),
  );
  // While the export runs on Express a, the same identity on Fastify d is busy.
  await pin(owner.context, 'd');
  await expect(async () => {
    const busy = await action(
      owner.page,
      'exportAll',
      secondTab,
      crypto.randomUUID(),
    );
    expect(busy.headers()['x-nestvexa-replica']).toBe('d');
    expect(busy.status()).toBe(409);
    expect((await busy.json()).code).toBe('ACTION_BUSY');
  }).toPass({ timeout: 5000 });
  // Another identity is not blocked by that lock.
  const other = await pinned(browser, 'd');
  const otherFields = await mounted(other.page);
  expect(
    (
      await action(other.page, 'exportAll', otherFields, crypto.randomUUID())
    ).status(),
  ).toBe(201);
  const finished = await running;
  expect(finished.status()).toBe(201);
  expect(finished.headers()['x-nestvexa-replica']).toBe('a');
  // Released when the first export finished: the waiting tab runs on d now.
  const after = await action(
    owner.page,
    'exportAll',
    secondTab,
    crypto.randomUUID(),
  );
  expect(after.status()).toBe(201);
  expect(after.headers()['x-nestvexa-replica']).toBe('d');
  await owner.context.close();
  await other.context.close();
});

/** An SSE subscription from this process that never reads until drained. */
function stalledStream(url: string, cookie: string) {
  return new Promise<{
    drain: () => Promise<{ bytes: number; text: string }>;
    close: () => void;
  }>((resolve, reject) => {
    const request = httpRequest(url, { headers: { cookie } }, (response) => {
      response.pause();
      resolve({
        drain: () => drain(response),
        close: () => request.destroy(),
      });
    });
    request.on('error', reject);
    request.end();
  });
}
function drain(response: IncomingMessage) {
  return new Promise<{ bytes: number; text: string }>((resolve) => {
    let bytes = 0;
    let text = '';
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      text += chunk.toString();
    });
    response.on('end', () => resolve({ bytes, text }));
    response.on('close', () => resolve({ bytes, text }));
    response.resume();
  });
}

test('a stalled subscriber is disconnected by its replica without slowing other browsers', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // A healthy browser on Fastify replica c (SSE) records every event.
  const healthy = await pinned(browser, 'c');
  const events = await recordEvents(healthy.page);
  const opened = sseOpened(healthy.page);
  await healthy.page.goto(proxy);
  await opened;
  // A second guest's identity and subscription token drive a client that
  // stops reading: the same replica, the same channel.
  const donor = await pinned(browser, 'c');
  await donor.page.goto(proxy);
  const token =
    (await donor.page
      .locator('[data-nv-name="replica-board"]')
      .getAttribute('data-nv-realtime')) ?? '';
  expect(token).not.toBe('');
  const cookie = (await donor.context.cookies(proxy))
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  await donor.context.close();
  await expect.poll(() => connections('c', healthy.page)).toBe(1);
  const stalled = await stalledStream(
    `${direct.c}/_nestvexa/realtime/sse?t=${encodeURIComponent(token)}`,
    cookie,
  );
  await expect.poll(() => connections('c', healthy.page)).toBe(2);
  const before = (await events()).length;
  // Express replica a publishes through Redis in batches of 100 × 15 KB until
  // replica c drops the stalled subscriber. How much a stalled socket absorbs
  // first is the 256 KiB transport bound plus kernel send/receive buffers,
  // which differ by OS (several MiB with Linux autotuning), so the test does
  // not fix a byte count. The cap (3,000 events, 45 MB) proves the bound: an
  // unbounded replica would never disconnect it.
  const cap = 3000;
  let published = 0;
  const batch = async () => {
    const response = await healthy.page.request.post(
      `${direct.a}/api/load/broadcast?count=100&offset=${published}`,
    );
    expect(await response.json()).toMatchObject({ published: 100 });
    published += 100;
    // The healthy browser keeps up batch by batch and stays connected.
    await expect
      .poll(async () => (await events()).length - before, { timeout: 60_000 })
      .toBe(published);
  };
  while ((await connections('c', healthy.page)) === 2 && published < cap)
    await batch();
  expect(await connections('c', healthy.page)).toBe(1);
  expect(published).toBeLessThan(cap);
  const atDisconnect = published;
  // Later events reach only the healthy browser.
  await batch();
  const drained = await stalled.drain();
  expect(drained.text).toContain('"reason":"slow-consumer"');
  const indexes = [...drained.text.matchAll(/"load":(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  expect(indexes.length).toBeLessThanOrEqual(atDisconnect);
  expect(Math.max(-1, ...indexes)).toBeLessThan(atDisconnect);
  expect(indexes).toEqual(indexes.map((_, at) => at));
  stalled.close();
  // Live keeps working for the healthy browser.
  const start = await total(healthy.page);
  await increment(healthy.page);
  await expect(healthy.page.locator('#total')).toHaveText(String(start + 1));
  await healthy.context.close();
  const probe = await browser.newContext();
  await expect
    .poll(
      async () =>
        Number(
          (await (await probe.request.get(`${direct.c}/api/health`)).json())
            .connections,
        ),
      { timeout: 30_000 },
    )
    .toBe(0);
  await probe.close();
});
