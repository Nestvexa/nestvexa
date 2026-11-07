import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from '@playwright/test';
import {
  aliceScope,
  bobScope,
  openQueuePage,
  startQueueFixture,
  storedQueue,
} from './offline-queue-support.js';
import type { QueueFixture } from './offline-queue-support.js';

const body = `
<p id="status" data-nv-queue-status></p>
<ul id="list" data-nv-queue-list></ul>
<form id="order" data-nv-queue="orders.place" action="/orders" method="post">
  <input name="sku" value="book-1" />
  <button id="place" type="submit">Place order</button>
</form>
<form id="elsewhere" data-nv-queue="notes.save" action="/admin/notes" method="post">
  <input name="title" value="redirected" />
  <button id="elsewhere-save" type="submit">Save</button>
</form>
<form id="note" data-nv-queue="notes.save" action="/notes" method="post">
  <label>Title <input id="title" name="title" /></label>
  <label>Password <input id="password" type="password" name="confirmWith" /></label>
  <label>Card <input id="card" name="billing" autocomplete="cc-number" /></label>
  <label>Private <input id="private" name="memo" data-nv-sensitive /></label>
  <label>Attachment <input id="file" type="file" name="attachment" /></label>
  <button id="save" type="submit">Save</button>
</form>`;

let fixture: QueueFixture;
let context: BrowserContext | undefined;
beforeAll(async () => {
  fixture = await startQueueFixture(body);
});
afterEach(async () => {
  await context?.close();
  context = undefined;
  fixture.state.identity = 'user:alice';
  fixture.state.csrf = 'csrf-1';
  fixture.state.statuses.length = 0;
  fixture.state.arrivals.length = 0;
  fixture.state.executed.length = 0;
});
afterAll(async () => {
  await fixture?.close();
});

async function open(
  options: Parameters<typeof openQueuePage>[1] = {},
): Promise<Page> {
  context ??= await fixture.browser.newContext();
  return openQueuePage(fixture, options, context);
}
/** Enqueue and return the error code, or `null` when it was accepted. */
function attempt(
  page: Page,
  action: string,
  fields: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  return page.evaluate(
    ({ action, fields }) => {
      const queue = window.nvQueueTest.queue;
      if (!queue) throw new Error('missing queue');
      try {
        queue.enqueue(action, fields as Record<string, string>);
        return null;
      } catch (error) {
        return error instanceof window.nvOffline.OfflineQueueError
          ? error.code
          : 'UNEXPECTED';
      }
    },
    { action, fields },
  );
}

describe('server allowlist', () => {
  it('refuses operations the server did not declare idempotent', async () => {
    const page = await open({ autoReplay: false });
    // The meta also lists orders.place without `idempotent: true`.
    expect(
      await page.evaluate(() =>
        window.nvQueueTest.queue?.actions.map((action) => action.id),
      ),
    ).toEqual(['notes.save', 'profile.update']);
    expect(
      await page.evaluate(() =>
        window.nvQueueTest.queue?.canQueue('orders.place'),
      ),
    ).toBe(false);
    expect(await attempt(page, 'orders.place', { sku: 'book-1' })).toBe(
      'NOT_ALLOWLISTED',
    );
    expect(await attempt(page, 'missing.action', { a: '1' })).toBe(
      'NOT_ALLOWLISTED',
    );

    // A form naming a non-idempotent action submits natively, never queued.
    await page.click('#place');
    expect(await page.evaluate(() => window.nvQueueTest.nativeSubmits)).toBe(1);
    expect(await page.getAttribute('#order', 'data-nv-queue-state')).toBe(
      'refused',
    );
    expect(await page.textContent('#status')).toBe(
      'This form cannot be saved on this device for later, so it was submitted directly.',
    );
    // An allowlisted id whose form posts somewhere else is refused too.
    await page.click('#elsewhere-save');
    expect(await page.evaluate(() => window.nvQueueTest.nativeSubmits)).toBe(2);
    expect(await storedQueue(page)).toEqual([]);
    expect(fixture.state.arrivals).toEqual([]);
  });

  it('ignores a hand-edited allowlist without a literal idempotent flag', async () => {
    const page = await open({ autoReplay: false, attach: false });
    // An invalid scope throws; the queue never falls back to a shared namespace.
    expect(
      await page.evaluate(() => {
        try {
          window.nvOffline.createOfflineQueue({ scope: 'short', actions: [] });
          return 'created';
        } catch {
          return 'refused';
        }
      }),
    ).toBe('refused');
    const accepted = await page.evaluate((scope) => {
      const queue = window.nvOffline.createOfflineQueue({
        scope,
        autoReplay: false,
        prefix: 'nv-queue-alt',
        actions: JSON.stringify({
          v: 1,
          actions: [
            { id: 'a.one', path: '/a', idempotent: 'true' },
            { id: 'a.two', path: '/b', idempotent: 1 },
            { id: 'a.three', path: '//evil.example/c', idempotent: true },
            { id: 'a.four', path: '/d', method: 'DELETE', idempotent: true },
            { id: 'a.five', path: '/e', method: 'GET', idempotent: true },
            { id: 'a.six', path: '/f', idempotent: true },
          ],
        }),
      });
      const ids = queue.actions.map((action) => action.id);
      queue.dispose();
      return ids;
    }, aliceScope);
    expect(accepted).toEqual(['a.six']);
  });
});

describe('secrets are never stored', () => {
  it('refuses secret-named fields in programmatic entries', async () => {
    const page = await open({ autoReplay: false, attach: false });
    for (const name of [
      'password',
      'newPassword',
      'api_key',
      'apiKey',
      'accessToken',
      'csrf',
      '_csrf',
      'otp',
      'cardNumber',
      'cvc',
      'clientSecret',
      'session_id',
    ])
      expect(await attempt(page, 'notes.save', { [name]: 'x' })).toBe(
        'SENSITIVE_FIELD',
      );
    expect(await attempt(page, 'notes.save', { title: { nested: 1 } })).toBe(
      'INVALID_FIELDS',
    );
    expect(
      await page.evaluate(() => {
        try {
          window.nvQueueTest.queue?.enqueue(
            'notes.save',
            JSON.parse('{"__proto__":"x"}') as Record<string, string>,
          );
          return null;
        } catch (error) {
          return error instanceof window.nvOffline.OfflineQueueError
            ? error.code
            : 'UNEXPECTED';
        }
      }),
    ).toBe('INVALID_FIELDS');
    expect(await storedQueue(page)).toEqual([]);
  });

  it('refuses a form with a filled password, payment, file or sensitive field', async () => {
    const page = await open({ autoReplay: false });
    const cases: readonly (readonly [
      string,
      (target: Page) => Promise<void>,
    ])[] = [
      ['password', (target) => target.fill('#password', 'hunter2')],
      ['card', (target) => target.fill('#card', '4111111111111111')],
      ['private', (target) => target.fill('#private', 'diary')],
      [
        'file',
        (target) =>
          target.setInputFiles('#file', {
            name: 'secret.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('file contents'),
          }),
      ],
    ];
    let native = 0;
    for (const [name, fill] of cases) {
      await page.evaluate(() =>
        (document.querySelector('#note') as HTMLFormElement | null)?.reset(),
      );
      await page.fill('#title', `with ${name}`);
      await fill(page);
      await page.click('#save');
      native++;
      expect(await page.evaluate(() => window.nvQueueTest.nativeSubmits)).toBe(
        native,
      );
      expect(await page.getAttribute('#note', 'data-nv-queue-state')).toBe(
        'refused',
      );
    }
    expect(await storedQueue(page)).toEqual([]);
    const raw = await page.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [
      'hunter2',
      '4111111111111111',
      'diary',
      'file contents',
    ])
      expect(raw).not.toContain(secret);

    // Empty sensitive fields are left out and the rest is queued (offline,
    // so the submit-triggered replay keeps it on the device).
    await context?.setOffline(true);
    await page.evaluate(() =>
      (document.querySelector('#note') as HTMLFormElement | null)?.reset(),
    );
    await page.fill('#title', 'plain');
    await page.click('#save');
    expect(await page.getAttribute('#note', 'data-nv-queue-state')).toBe(
      'queued',
    );
    expect((await storedQueue(page)).map((record) => record['fields'])).toEqual(
      [{ title: 'plain' }],
    );
  });
});

describe('bounds and expiry', () => {
  it('enforces the entry count and per-entry byte limits', async () => {
    const page = await open({
      autoReplay: false,
      attach: false,
      maxEntries: 2,
      maxBytes: 512,
    });
    // Discarding resumes replay; stay offline so the remaining entry stays.
    await context?.setOffline(true);
    expect(await attempt(page, 'notes.save', { title: 'one' })).toBeNull();
    expect(await attempt(page, 'notes.save', { title: 'two' })).toBeNull();
    expect(await attempt(page, 'notes.save', { title: 'three' })).toBe(
      'QUEUE_FULL',
    );
    await page.evaluate(() => {
      const queue = window.nvQueueTest.queue;
      const first = queue?.list()[0];
      if (first) queue?.discard(first.id);
    });
    expect(await attempt(page, 'notes.save', { title: 'x'.repeat(600) })).toBe(
      'TOO_LARGE',
    );
    expect(await storedQueue(page)).toHaveLength(1);
    expect(
      await page.evaluate((scope) => {
        try {
          window.nvOffline.createOfflineQueue({ scope, maxEntries: 101 });
          return 'created';
        } catch {
          return 'refused';
        }
      }, aliceScope),
    ).toBe('refused');
  });

  it('drops expired entries without sending them and announces it', async () => {
    const page = await open({
      autoReplay: false,
      ttlMs: 1_000,
      clock: 1_000_000,
    });
    expect(await attempt(page, 'notes.save', { title: 'stale' })).toBeNull();
    expect(
      await attempt(page, 'notes.save', { title: 'stale too' }),
    ).toBeNull();
    await page.evaluate(() => {
      window.nvQueueTest.clock = 1_001_000;
    });
    await page.evaluate(() => window.nvQueueTest.queue?.replay());
    expect(fixture.state.arrivals).toEqual([]);
    expect(await storedQueue(page)).toEqual([]);
    expect(await page.evaluate(() => window.nvQueueTest.events)).toContain(
      'expired',
    );
    await expect
      .poll(() => page.textContent('#status'))
      .toBe('Unsent changes expired and were removed from this device: 2.');
  });
});

describe('identity scoping', () => {
  it('never sends another identity’s entries and purges them on this device', async () => {
    const alice = await open({ autoReplay: false });
    expect(await attempt(alice, 'notes.save', { title: 'alice' })).toBeNull();
    expect((await storedQueue(alice))[0]?.['scope']).toBe(aliceScope);
    await alice.evaluate(() => window.nvQueueTest.queue?.dispose());

    // Bob signs in on the same device: Alice's entry is removed unsent.
    const bob = await open({ scope: bobScope });
    expect(await bob.evaluate(() => window.nvQueueTest.queue?.list())).toEqual(
      [],
    );
    expect(await storedQueue(bob)).toEqual([]);
    await bob.evaluate(() => window.nvQueueTest.queue?.replay());
    expect(fixture.state.arrivals).toEqual([]);
  });

  it('is refused by the server when the session changed identity before replay', async () => {
    const page = await open({ autoReplay: false });
    expect(await attempt(page, 'notes.save', { title: 'alice' })).toBeNull();
    fixture.state.identity = 'user:bob';
    await page.evaluate(() => window.nvQueueTest.queue?.replay());
    expect(fixture.state.arrivals).toMatchObject([
      { path: '/notes', scope: aliceScope, status: 403, outcome: 'rejected' },
    ]);
    expect(fixture.state.executed).toEqual([]);
    expect(
      await page.evaluate(() => window.nvQueueTest.queue?.list()[0]),
    ).toMatchObject({ state: 'failed', code: 'OFFLINE_SCOPE_MISMATCH' });
  });

  it('purges queued entries on logout and closes the queue', async () => {
    const page = await open({ autoReplay: false });
    expect(await attempt(page, 'notes.save', { title: 'one' })).toBeNull();
    const removed = await page.evaluate(() =>
      window.nvOffline.announceLogout(),
    );
    expect(removed).toBe(1);
    expect(await storedQueue(page)).toEqual([]);
    expect(await attempt(page, 'notes.save', { title: 'two' })).toBe('CLOSED');
    expect(await page.textContent('#status')).toBe('');
  });

  it('revalidates stored records and never sends tampered ones', async () => {
    const page = await open({ autoReplay: false, attach: false });
    await page.evaluate((scope) => {
      const id = (n: string) => n.repeat(32);
      const record = (key: string, fields: unknown, extra = {}) =>
        localStorage.setItem(
          `nv-queue:v1:${scope}:${key}`,
          JSON.stringify({
            v: 1,
            scope,
            id: key,
            action: 'notes.save',
            order: 1,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            attempts: 0,
            state: 'pending',
            fields,
            ...extra,
          }),
        );
      record(id('a'), { password: 'planted' });
      record(id('b'), { title: 'ok' }, { scope: 'another-scope-0123456789' });
      record(
        id('c'),
        { title: 'ok' },
        { expiresAt: Date.now() + 48 * 3_600_000 },
      );
      record('not-a-request-id', { title: 'ok' });
    }, aliceScope);
    await page.evaluate(() => window.nvQueueTest.queue?.replay());
    expect(await storedQueue(page)).toEqual([]);
    expect(fixture.state.arrivals).toEqual([]);
  });
});
