import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// examples/distributed-live in standalone mode: one replica configured for the
// WebSocket transport (3226) and one for `auto` (3227).
const websocketOrigin = 'http://127.0.0.1:3226';
const autoOrigin = 'http://127.0.0.1:3227';

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

test('an event published by one session refreshes another session over WebSocket', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  const errors: string[] = [];
  second.on('pageerror', (error) => errors.push(error.message));
  const socket = websocketReady(second);
  await first.goto(websocketOrigin);
  await second.goto(websocketOrigin);
  // The server acknowledges the token handshake before any invalidation.
  expect(await socket).toBe('ws://127.0.0.1:3226/_nestvexa/realtime/ws');
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

test('auto falls back to long-polling when the SSE stream is blocked', async ({
  browser,
}) => {
  const { first, second, close } = await twoSessions(browser);
  // A proxy that refuses event streams: every SSE request fails.
  await second.route('**/_nestvexa/realtime/sse?**', (route) => route.abort());
  const polled = second.waitForResponse(
    (response) =>
      response.url().includes('/_nestvexa/realtime/poll?') &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await first.goto(autoOrigin);
  await second.goto(autoOrigin);
  const before = Number(await second.locator('#total').textContent());
  // Keep publishing until the fallback long-poll is established and delivers.
  await expect(async () => {
    await increment(first);
    await expect(second.locator('#total')).not.toHaveText(String(before), {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await polled;
  await close();
});
