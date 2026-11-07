import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import type { FixtureBrowser } from './offline-support.js';
import { aliceScope, startQueueFixture } from './offline-queue-support.js';
import type { QueueFixture } from './offline-queue-support.js';

const body = `
<p id="status" data-nv-queue-status role="status"></p>
<ul id="list" data-nv-queue-list></ul>
<form id="note" data-nv-queue="notes.save" action="/notes" method="post">
  <input type="hidden" name="_csrf" value="csrf-hidden-value" />
  <label>Title <input id="title" name="title" /></label>
  <button id="save" type="submit">Save</button>
</form>`;

async function attach(page: Page): Promise<void> {
  await page.evaluate((scope) => {
    const queue = window.nvOffline.createOfflineQueue({
      scope,
      retry: { baseMs: 50, maxMs: 200 },
    });
    window.nvOffline.attachOfflineQueue(document, { queue });
    Reflect.set(window, 'nvQueue', queue);
  }, aliceScope);
}
function entries(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('nv-queue:')),
  );
}

describe.each<FixtureBrowser>(['chromium', 'firefox', 'webkit'])(
  'offline queue replay in %s',
  (browserName) => {
    let fixture: QueueFixture;
    beforeAll(async () => {
      fixture = await startQueueFixture(body, browserName);
    });
    afterAll(async () => {
      await fixture?.close();
    });

    it('queues while offline and replays once with the same request ID when back online', async () => {
      const context = await fixture.browser.newContext();
      const page = await fixture.page(context);
      await attach(page);
      await context.setOffline(true);
      await page.fill('#title', `Offline note (${browserName})`);
      await page.click('#save');
      await expect
        .poll(() => page.textContent('#status'))
        .toBe('Saved on this device and waiting to be sent: 1.');
      // Either the browser reported offline (nothing attempted) or the attempt
      // failed at the network layer; the server saw nothing in both cases.
      expect(fixture.state.arrivals).toEqual([]);
      const keys = await entries(page);
      expect(keys).toHaveLength(1);
      const id = keys[0]?.split(':').at(-1) ?? '';
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(await page.inputValue('#title')).toBe('');
      expect(await page.getAttribute('#note', 'data-nv-queue-state')).toBe(
        'queued',
      );
      expect(
        await page.evaluate(() => JSON.stringify(localStorage)),
      ).not.toContain('csrf');

      await context.setOffline(false);
      // `online` triggers replay; WebKit may only notice on the backoff timer.
      await expect
        .poll(() => page.textContent('#status'), { timeout: 10_000 })
        .toBe('All saved changes were sent.');
      expect(await entries(page)).toEqual([]);
      expect(fixture.state.executed).toEqual([
        {
          path: '/notes',
          key: id,
          body: { title: `Offline note (${browserName})` },
        },
      ]);
      const delivered = fixture.state.arrivals.filter(
        (arrival) => arrival.outcome === 'executed',
      );
      expect(delivered).toEqual([
        {
          method: 'POST',
          path: '/notes',
          key: id,
          scope: aliceScope,
          csrf: 'csrf-1',
          status: 201,
          outcome: 'executed',
        },
      ]);

      // A duplicate delivery of the same request ID is answered from the
      // server's record and never executes again.
      const duplicate = await fetch(`${fixture.base}/notes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': id,
          'x-nestvexa-offline-scope': aliceScope,
          'x-nestvexa-csrf': 'csrf-1',
        },
        body: new URLSearchParams({
          title: `Offline note (${browserName})`,
        }).toString(),
      });
      expect(duplicate.status).toBe(201);
      expect(duplicate.headers.get('x-nestvexa-offline-replayed')).toBe('1');
      expect(fixture.state.executed).toHaveLength(1);

      // Reopening the page (same storage) never resends what was delivered.
      // A fresh page is used because Firefox's page.reload() can hang after
      // an offline toggle under Playwright.
      expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
      await page.close();
      const reopened = await fixture.page(context);
      await attach(reopened);
      await reopened.waitForTimeout(150);
      expect(await entries(reopened)).toEqual([]);
      expect(fixture.state.executed).toHaveLength(1);
      expect(await reopened.evaluate(() => window.nvViolations)).toEqual([]);
      await context.close();
    }, 60_000);
  },
);
