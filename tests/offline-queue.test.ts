import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from '@playwright/test';
import {
  aliceScope,
  openQueuePage,
  startQueueFixture,
  storedQueue,
} from './offline-queue-support.js';
import type { QueueFixture } from './offline-queue-support.js';

const body = `
<p id="status"
  data-nv-queue-status
  data-nv-queue-message-pending="En attente : {count}"
  data-nv-queue-message-pending-one="Une modification en attente"
  data-nv-queue-message-sent="Tout est envoyé"
  data-nv-queue-message-discarded="Modification annulée"></p>
<ul id="list" data-nv-queue-list data-nv-queue-label-discard="Annuler" data-nv-queue-label-pending="En attente"></ul>
<form id="note" data-nv-queue="notes.save" action="/notes" method="post">
  <input type="hidden" name="_csrf" value="csrf-hidden-value" />
  <input type="hidden" name="noteId" value="n1" />
  <label>Title <input id="title" name="title" /></label>
  <label>Body <textarea id="body" name="body"></textarea></label>
  <label>Pinned <input id="pinned" type="checkbox" name="pinned" value="yes" /></label>
  <label>Tags <select id="tags" name="tags" multiple><option value="a">A</option><option value="b">B</option></select></label>
  <label>Local only <input id="local" name="local" data-nv-queue-never /></label>
  <button id="save" type="submit">Save</button>
</form>`;

let fixture: QueueFixture;
let context: BrowserContext | undefined;
let page: Page | undefined;
beforeAll(async () => {
  fixture = await startQueueFixture(body);
});
afterEach(async () => {
  await page
    ?.evaluate(() => window.nvQueueTest.queue?.dispose())
    .catch(() => undefined);
  await context?.close();
  context = undefined;
  page = undefined;
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
  context = await fixture.browser.newContext();
  page = await openQueuePage(fixture, options, context);
  return page;
}
function enqueue(target: Page, title: string, action = 'notes.save') {
  return target.evaluate(
    ({ title, action }) => {
      const queue = window.nvQueueTest.queue;
      if (!queue) throw new Error('missing queue');
      return queue.enqueue(action, { title }).id;
    },
    { title, action },
  );
}
function replay(target: Page) {
  return target.evaluate(() => window.nvQueueTest.queue?.replay());
}

describe('queued form submissions', () => {
  it('queues an allowlisted form without CSRF or never-fields and replays it with the current token', async () => {
    const opened = await open();
    await context?.setOffline(true);
    await opened.fill('#title', 'Groceries');
    await opened.fill('#body', 'Milk');
    await opened.check('#pinned');
    await opened.selectOption('#tags', ['a', 'b']);
    await opened.fill('#local', 'device only');
    await opened.click('#save');
    await expect
      .poll(() => opened.textContent('#status'))
      .toBe('Une modification en attente');
    expect(await opened.getAttribute('#status', 'role')).toBe('status');
    expect(await opened.getAttribute('#status', 'data-nv-queue-count')).toBe(
      '1',
    );
    expect(await opened.getAttribute('#status', 'data-nv-queue-state')).toBe(
      'pending',
    );
    expect(await opened.inputValue('#title')).toBe('');
    expect(await opened.evaluate(() => window.nvQueueTest.nativeSubmits)).toBe(
      0,
    );
    const [record] = await storedQueue(opened);
    expect(record?.['scope']).toBe(aliceScope);
    expect(record?.['fields']).toEqual({
      noteId: 'n1',
      title: 'Groceries',
      body: 'Milk',
      pinned: 'yes',
      tags: ['a', 'b'],
    });
    const raw = await opened.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [
      'csrf-hidden-value',
      'csrf-1',
      'device only',
      '_csrf',
    ])
      expect(raw).not.toContain(secret);

    // The token rotates while offline; the replay reads the current one.
    fixture.state.csrf = 'csrf-2';
    await opened.evaluate(() =>
      document
        .querySelector('meta[name="nestvexa-csrf"]')
        ?.setAttribute('content', 'csrf-2'),
    );
    await context?.setOffline(false);
    await expect
      .poll(() => opened.textContent('#status'))
      .toBe('Tout est envoyé');
    expect(fixture.state.arrivals).toMatchObject([
      { method: 'POST', path: '/notes', csrf: 'csrf-2', status: 201 },
    ]);
    expect(fixture.state.executed).toEqual([
      {
        path: '/notes',
        key: record?.['id'],
        body: {
          noteId: 'n1',
          title: 'Groceries',
          body: 'Milk',
          pinned: 'yes',
          tags: ['a', 'b'],
        },
      },
    ]);
    expect(await opened.$$('#list li')).toHaveLength(0);
    expect(await opened.evaluate(() => window.nvViolations)).toEqual([]);
  });

  it('sends the @nestvexa/actions JSON envelope with the declared method', async () => {
    const opened = await open({ autoReplay: false });
    const id = await opened.evaluate(
      () =>
        window.nvQueueTest.queue?.enqueue('profile.update', {
          displayName: 'Alice',
          age: 41,
          newsletter: true,
          nickname: null,
        }).id,
    );
    await replay(opened);
    expect(fixture.state.arrivals).toMatchObject([
      { method: 'PATCH', path: '/profile', key: id, scope: aliceScope },
    ]);
    expect(fixture.state.executed[0]?.body).toEqual({
      input: {
        displayName: 'Alice',
        age: 41,
        newsletter: true,
        nickname: null,
      },
    });
  });
});

describe('ordered replay', () => {
  it('replays in order with the original request IDs and halts at the first non-retryable failure', async () => {
    const opened = await open({ autoReplay: false });
    const first = await enqueue(opened, 'one');
    const second = await enqueue(opened, 'two');
    const third = await enqueue(opened, 'three');
    fixture.state.statuses.push(0, 422);
    await replay(opened);
    expect(fixture.state.executed.map((item) => item.key)).toEqual([first]);
    expect(
      fixture.state.arrivals.map((item) => [item.key, item.status]),
    ).toEqual([
      [first, 201],
      [second, 422],
    ]);
    const listed = await opened.evaluate(() =>
      window.nvQueueTest.queue?.list(),
    );
    expect(listed).toMatchObject([
      { id: second, state: 'failed', status: 422, code: 'FORCED', attempts: 1 },
      { id: third, state: 'pending', attempts: 0 },
    ]);
    expect(await opened.getAttribute('#status', 'data-nv-queue-state')).toBe(
      'failed',
    );
    expect(await opened.textContent('#status')).toContain(
      'could not be sent and the rest are on hold',
    );
    expect(
      await opened.getAttribute(
        `[data-nv-queue-entry="${second}"]`,
        'data-nv-queue-entry-code',
      ),
    ).toBe('FORCED');
    // Halted: another replay sends nothing until the user decides.
    await replay(opened);
    expect(fixture.state.arrivals).toHaveLength(2);
    await opened.click(`[data-nv-queue-discard="${second}"]`);
    await expect
      .poll(() => fixture.state.executed.map((item) => item.key))
      .toEqual([first, third]);
    await expect
      .poll(() => opened.textContent('#status'))
      .toBe('Tout est envoyé');
  });

  it('retries network errors and transient statuses with backoff, keeping the request ID', async () => {
    const opened = await open({
      autoReplay: false,
      retry: { baseMs: 20, maxMs: 40 },
    });
    let aborted = false;
    await opened.route('**/notes', async (route) => {
      if (aborted) return route.continue();
      aborted = true;
      return route.abort('internetdisconnected');
    });
    await opened.evaluate(() => {
      const state = window.nvQueueTest;
      Reflect.set(window, 'nvStates', [] as string[]);
      state.queue?.subscribe(() => {
        const entry = state.queue?.list()[0];
        if (entry)
          (Reflect.get(window, 'nvStates') as string[]).push(entry.state);
      });
    });
    fixture.state.statuses.push(503, 429, {
      status: 409,
      code: 'OFFLINE_IN_PROGRESS',
    });
    const id = await enqueue(opened, 'flaky');
    await replay(opened);
    await expect.poll(() => fixture.state.executed.length).toBe(1);
    expect(aborted).toBe(true);
    expect(
      fixture.state.arrivals.map((item) => [item.key, item.status]),
    ).toEqual([
      [id, 503],
      [id, 429],
      [id, 409],
      [id, 201],
    ]);
    const states = await opened.evaluate(
      () => Reflect.get(window, 'nvStates') as string[],
    );
    expect(states).toContain('retrying');
    expect(states).toContain('sending');
    expect(await storedQueue(opened)).toEqual([]);
  });

  it('treats redirects and CSRF refusals as non-retryable and lets the user retry', async () => {
    const opened = await open({ autoReplay: false });
    const id = await enqueue(opened, 'redirected');
    fixture.state.statuses.push(303);
    await replay(opened);
    expect(
      await opened.evaluate(() => window.nvQueueTest.queue?.list()[0]),
    ).toMatchObject({ id, state: 'failed', code: 'REDIRECT' });
    fixture.state.csrf = 'rotated-on-server';
    await opened.click(`[data-nv-queue-retry="${id}"]`);
    await expect
      .poll(() =>
        opened.evaluate(() => window.nvQueueTest.queue?.list()[0]?.code),
      )
      .toBe('CSRF');
    expect(fixture.state.executed).toEqual([]);
    fixture.state.csrf = 'csrf-1';
    await opened.click(`[data-nv-queue-retry="${id}"]`);
    await expect.poll(() => fixture.state.executed.length).toBe(1);
    expect(fixture.state.executed[0]?.key).toBe(id);
  });
});

describe('status region and list', () => {
  it('renders translatable text-only status, labelled entries and keyboard discard', async () => {
    const opened = await open({ autoReplay: false });
    // Discarding resumes replay, so stay offline to keep both entries queued.
    await context?.setOffline(true);
    const first = await enqueue(opened, 'one');
    const second = await enqueue(opened, 'two');
    await opened.evaluate(() => window.nvQueueTest.queue?.list());
    await expect
      .poll(() => opened.textContent('#status'))
      .toBe('En attente : 2');
    expect(await opened.$$eval('#status *', (nodes) => nodes.length)).toBe(0);
    const items = await opened.$$eval('#list li', (nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-nv-queue-entry'),
        state: node.getAttribute('data-nv-queue-entry-state'),
        label: node.querySelector('[data-nv-queue-entry-label]')?.textContent,
        status: node.querySelector('[data-nv-queue-entry-status]')?.textContent,
        time: node.querySelector('time')?.getAttribute('datetime'),
      })),
    );
    expect(items).toMatchObject([
      { id: first, state: 'pending', label: 'Save note', status: 'En attente' },
      {
        id: second,
        state: 'pending',
        label: 'Save note',
        status: 'En attente',
      },
    ]);
    expect(items[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const discard = opened.getByRole('button', { name: 'Annuler: Save note' });
    expect(await discard.count()).toBe(2);
    await opened.focus(`[data-nv-queue-discard="${first}"]`);
    await opened.keyboard.press('Enter');
    await expect
      .poll(() => opened.textContent('#status'))
      .toBe('Modification annulée Une modification en attente');
    // Focus moves to the next entry's control instead of being lost.
    expect(
      await opened.evaluate(() =>
        document.activeElement?.getAttribute('data-nv-queue-discard'),
      ),
    ).toBe(second);
    await opened.keyboard.press('Enter');
    await expect.poll(() => opened.$$('#list li')).toHaveLength(0);
    expect(await opened.textContent('#status')).toBe('Modification annulée');
    expect(await opened.getAttribute('#status', 'data-nv-queue-state')).toBe(
      'idle',
    );
    expect(fixture.state.arrivals).toEqual([]);
    expect(await opened.evaluate(() => window.nvViolations)).toEqual([]);
  });

  it('keeps other tabs of the same identity in sync through storage events', async () => {
    const opened = await open({ autoReplay: false });
    const other = await openQueuePage(fixture, { autoReplay: false }, context);
    const id = await enqueue(opened, 'shared');
    await expect
      .poll(() => other.getAttribute('#list li', 'data-nv-queue-entry'))
      .toBe(id);
    await other.click(`[data-nv-queue-discard="${id}"]`);
    await expect.poll(() => opened.$$('#list li')).toHaveLength(0);
    await other.evaluate(() => window.nvQueueTest.queue?.dispose());
  });
});
