import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// examples/distributed-live in standalone mode, one replica per transport
// setting. Ports can be overridden for isolated local runs.
const origin = (variable: string, port: number) =>
  `http://127.0.0.1:${process.env[variable] ?? port}`;
const websocketOrigin = origin('NV_RT_WEBSOCKET_PORT', 3226);
const autoOrigin = origin('NV_RT_AUTO_PORT', 3227);
const pollingOrigin = origin('NV_RT_POLLING_PORT', 3800);
const fastifyOrigin = origin('NV_RT_FASTIFY_PORT', 3801);
const socketPath = '/_nestvexa/realtime/ws';

async function twoSessions(browser: Browser) {
  const first = await browser.newContext();
  const second = await browser.newContext();
  return {
    first: await first.newPage(),
    second: await second.newPage(),
    close: async () => {
      await first.close();
      await second.close();
    },
  };
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
async function increment(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Increment shared total' }).click();
}
/** Publish from `first` until `second` (which never acted) shows the change. */
async function delivers(first: Page, second: Page): Promise<void> {
  const before = Number(await second.locator('#total').textContent());
  await expect(async () => {
    await increment(first);
    await expect(second.locator('#total')).not.toHaveText(String(before), {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(second.locator('#clicks')).toHaveText('0');
}
/** The realtime transport requests a page made, by kind. */
function transportLog(page: Page) {
  const seen = { negotiate: 0, sse: 0, poll: 0, websocket: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/_nestvexa/realtime/negotiate')) seen.negotiate++;
    if (url.includes('/_nestvexa/realtime/sse?')) seen.sse++;
    if (url.includes('/_nestvexa/realtime/poll?')) seen.poll++;
  });
  page.on('websocket', () => seen.websocket++);
  return seen;
}

test('an event published by one session refreshes another session over WebSocket', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const errors: string[] = [];
  second.on('pageerror', (error) => errors.push(error.message));
  const socket = websocketReady(second);
  // The first session's client is mounted once its own socket is ready.
  const firstReady = websocketReady(first);
  await first.goto(websocketOrigin);
  await second.goto(websocketOrigin);
  await firstReady;
  // The server acknowledges the token handshake before any invalidation.
  expect(await socket).toBe(
    `${websocketOrigin.replace('http', 'ws')}${socketPath}`,
  );
  const before = Number(await second.locator('#total').textContent());
  await increment(first);
  await expect(first.locator('#clicks')).toHaveText('1');
  // The second session never acted: its own authorized $sync refreshed it.
  await expect(second.locator('#total')).toHaveText(String(before + 1));
  await expect(second.locator('#clicks')).toHaveText('0');
  // Presence counts the identities connected to this replica's channel.
  await increment(second);
  await expect(second.locator('#viewers')).not.toHaveText('0');
  expect(errors).toEqual([]);
  await close();
});

test('the explicit polling transport delivers events by long-polling only', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const seen = transportLog(second);
  await first.goto(pollingOrigin);
  await second.goto(pollingOrigin);
  await delivers(first, second);
  expect(seen.poll).toBeGreaterThan(0);
  expect(seen).toMatchObject({ negotiate: 0, sse: 0, websocket: 0 });
  await close();
});

test('auto negotiates the WebSocket transport the server offers', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const seen = transportLog(second);
  const socket = websocketReady(second);
  await first.goto(autoOrigin);
  await second.goto(autoOrigin);
  expect(await socket).toBe(`${autoOrigin.replace('http', 'ws')}${socketPath}`);
  await delivers(first, second);
  expect(seen.negotiate).toBe(1);
  expect(seen).toMatchObject({ sse: 0, poll: 0 });
  await close();
});

test('auto falls back from WebSocket to SSE when upgrades are refused', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const seen = transportLog(second);
  let refused = 0;
  // A proxy without WebSocket support: every upgrade is closed before ready.
  await second.routeWebSocket(
    (url) => url.pathname === socketPath,
    (ws) => {
      refused++;
      ws.close({ code: 1011, reason: 'blocked' });
    },
  );
  const stream = second.waitForResponse(
    (response) =>
      response.url().includes('/_nestvexa/realtime/sse?') &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await first.goto(autoOrigin);
  await second.goto(autoOrigin);
  await stream;
  await delivers(first, second);
  // Two refused upgrades before the switch; none after it.
  expect(refused).toBe(2);
  expect(seen.poll).toBe(0);
  await close();
});

test('auto falls back to long-polling when WebSocket and SSE are both blocked', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  await second.routeWebSocket(
    (url) => url.pathname === socketPath,
    (ws) => ws.close({ code: 1011, reason: 'blocked' }),
  );
  // ...and a proxy that refuses event streams: every SSE request fails.
  await second.route('**/_nestvexa/realtime/sse?**', (route) => route.abort());
  const polled = second.waitForResponse(
    (response) =>
      response.url().includes('/_nestvexa/realtime/poll?') &&
      response.status() === 200,
    { timeout: 45_000 },
  );
  await first.goto(autoOrigin);
  await second.goto(autoOrigin);
  await delivers(first, second);
  await polled;
  await close();
});

test('a Fastify replica negotiates WebSocket under auto and delivers events', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const socket = websocketReady(second);
  await first.goto(fastifyOrigin);
  await second.goto(fastifyOrigin);
  await expect(second.locator('#http-adapter')).toHaveText('fastify');
  expect(await socket).toBe(
    `${fastifyOrigin.replace('http', 'ws')}${socketPath}`,
  );
  await delivers(first, second);
  const health = await second.request.get(`${fastifyOrigin}/api/health`);
  expect(await health.json()).toMatchObject({
    adapter: 'fastify',
    transports: ['websocket', 'sse', 'polling'],
  });
  await close();
});
