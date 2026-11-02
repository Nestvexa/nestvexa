import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { startOfflineFixture } from './offline-support.js';
import type { OfflineFixture } from './offline-support.js';

declare global {
  interface Window {
    nvDraftTest: {
      submits: number;
      inputs: number;
      changes: number;
      controller: { refresh(): void; dispose(): void } | null;
      errors: string[];
      logouts: number;
    };
  }
}

const alice = 'scope-alice-0123456789';
const bob = 'scope-bob-000123456789';
const form = `
<div data-nv-component="c1" id="component">
  <form id="product" data-nv-draft="product" data-nv-draft-message-restored="Brouillon restauré">
    <p data-nv-draft-status role="status"></p>
    <label>Title <input id="title" name="title" data-nv-draft-field /></label>
    <label>Notes <textarea id="notes" name="notes" data-nv-draft-field></textarea></label>
    <label>Unmarked <input id="unmarked" name="unmarked" /></label>
    <label>Password <input id="secret" name="secret" type="password" data-nv-draft-field /></label>
    <input name="token" type="hidden" value="csrf-token" data-nv-draft-field />
    <label>File <input id="upload" name="upload" type="file" data-nv-draft-field /></label>
    <label>Card <input id="card" name="card" autocomplete="cc-number" data-nv-draft-field /></label>
    <label>Code <input id="otp" name="otp" autocomplete="one-time-code" data-nv-draft-field /></label>
    <label>Never <input id="never" name="never" data-nv-draft-field data-nv-draft-never /></label>
    <label>Featured <input id="featured" name="featured" type="checkbox" data-nv-draft-field /></label>
    <label>Tags <select id="tags" name="tags" multiple data-nv-draft-field><option value="a">A</option><option value="b">B</option></select></label>
    <label>Calm <input id="calm" type="radio" name="tone" value="calm" data-nv-draft-field /></label>
    <label>Bold <input id="bold" type="radio" name="tone" value="bold" data-nv-draft-field /></label>
    <button id="save" type="submit">Save</button>
  </form>
</div>
<form id="logout-form" data-nv-logout action="/logout" method="post"><button id="logout-submit">Log out</button></form>
<button type="button" id="logout-button" data-nv-logout>Log out everywhere</button>
<section id="later"></section>`;

let fixture: OfflineFixture;
let page: Page;
beforeAll(async () => {
  fixture = await startOfflineFixture(form);
});
afterEach(async () => {
  await page
    ?.evaluate(() => window.nvDraftTest?.controller?.dispose())
    .catch(() => undefined);
  await page?.close();
});
afterAll(async () => {
  await fixture?.close();
});

async function open(scope = alice, attach = true): Promise<Page> {
  const opened = await fixture.page();
  await opened.evaluate(
    ({ scope, attach }) => {
      const state = {
        submits: 0,
        inputs: 0,
        changes: 0,
        controller: null as { refresh(): void; dispose(): void } | null,
        errors: [] as string[],
        logouts: 0,
      };
      window.nvDraftTest = state;
      // Stands in for the Live client, which owns submission.
      document.addEventListener('submit', (event) => {
        state.submits++;
        event.preventDefault();
      });
      document.addEventListener('input', () => state.inputs++, true);
      document.addEventListener('change', () => state.changes++, true);
      window.addEventListener('nestvexa:logout', () => state.logouts++);
      if (!attach) return;
      const store = window.nvOffline.createDraftStore({
        scope,
        onError: (error) =>
          state.errors.push(error instanceof Error ? error.name : 'unknown'),
      });
      state.controller = window.nvOffline.attachOfflineDrafts(document, {
        store,
        debounceMs: 10,
      });
    },
    { scope, attach },
  );
  return opened;
}
function stored(target: Page, scope = alice, id = 'product') {
  return target.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }, `nv-draft:v1:${scope}:${id}`);
}

describe('opt-in draft capture', () => {
  it('stores only explicitly marked, non-sensitive fields', async () => {
    page = await open();
    await page.fill('#title', 'Desk lamp');
    await page.fill('#notes', 'Warm white');
    await page.fill('#unmarked', 'not saved');
    await page.fill('#secret', 'hunter2');
    await page.fill('#card', '4111111111111111');
    await page.fill('#otp', '864213');
    await page.fill('#never', 'never saved');
    await page.check('#featured');
    await page.selectOption('#tags', ['a', 'b']);
    await page.check('#bold');
    await page.waitForFunction(() =>
      localStorage
        .getItem('nv-draft:v1:scope-alice-0123456789:product')
        ?.includes('bold'),
    );
    const record = await stored(page);
    expect(record?.['v']).toBe(1);
    expect(record?.['scope']).toBe(alice);
    expect(record?.['fields']).toEqual({
      title: 'Desk lamp',
      notes: 'Warm white',
      featured: true,
      tags: ['a', 'b'],
      tone: 'bold',
    });
    const raw = await page.evaluate(() => JSON.stringify(localStorage));
    for (const secret of [
      'hunter2',
      '4111',
      '864213',
      'csrf-token',
      'not saved',
      'never saved',
    ])
      expect(raw).not.toContain(secret);
    expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
  });

  it('clears the draft when every field returns to its default', async () => {
    page = await open();
    await page.fill('#title', 'Temporary');
    await page.waitForFunction(() => localStorage.length > 0);
    await page.fill('#title', '');
    await page.waitForFunction(() => localStorage.length === 0);
    expect(await stored(page)).toBeNull();
  });
});

describe('restoration', () => {
  it('restores values with input/change events but never submits or calls the network', async () => {
    page = await open();
    await page.fill('#title', 'Restored lamp');
    await page.check('#calm');
    await page.waitForFunction(() =>
      localStorage
        .getItem('nv-draft:v1:scope-alice-0123456789:product')
        ?.includes('calm'),
    );
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.reload();
    await page.waitForFunction(() => Reflect.has(window, 'nvOffline'));
    requests.length = 0;
    await page.evaluate((scope) => {
      const state = { submits: 0, inputs: 0, changes: 0 };
      document.addEventListener('submit', (event) => {
        state.submits++;
        event.preventDefault();
      });
      document.addEventListener('input', () => state.inputs++, true);
      document.addEventListener('change', () => state.changes++, true);
      Reflect.set(window, 'restoreState', state);
      const store = window.nvOffline.createDraftStore({ scope });
      window.nvOffline.attachOfflineDrafts(document, { store });
    }, alice);
    await expect(page.inputValue('#title')).resolves.toBe('Restored lamp');
    expect(await page.isChecked('#calm')).toBe(true);
    const state = await page.evaluate(
      () =>
        Reflect.get(window, 'restoreState') as {
          submits: number;
          inputs: number;
          changes: number;
        },
    );
    expect(state.submits).toBe(0);
    expect(state.inputs).toBe(2);
    expect(state.changes).toBe(2);
    expect(await page.getAttribute('#product', 'data-nv-draft-state')).toBe(
      'restored',
    );
    expect(await page.textContent('[data-nv-draft-status]')).toBe(
      'Brouillon restauré',
    );
    await page.waitForTimeout(100);
    expect(requests).toEqual([]);
  });

  it('does not overwrite a form the user already changed', async () => {
    page = await open(alice, false);
    await page.evaluate((scope) => {
      const store = window.nvOffline.createDraftStore({ scope });
      store.save('product', { title: 'From draft' });
      const title = document.querySelector('#title');
      if (title instanceof HTMLInputElement) title.value = 'Typed already';
      window.nvDraftTest.controller = window.nvOffline.attachOfflineDrafts(
        document,
        { store },
      );
    }, alice);
    expect(await page.inputValue('#title')).toBe('Typed already');
    expect(
      await page.getAttribute('#product', 'data-nv-draft-state'),
    ).toBeNull();
  });

  it('restores forms inserted later through the MutationObserver', async () => {
    page = await open(alice, false);
    await page.evaluate((scope) => {
      const store = window.nvOffline.createDraftStore({ scope });
      store.save('later', { subject: 'Hello later' });
      window.nvDraftTest.controller = window.nvOffline.attachOfflineDrafts(
        document,
        { store },
      );
      document
        .querySelector('#later')
        ?.insertAdjacentHTML(
          'beforeend',
          '<form data-nv-draft="later"><p data-nv-draft-status></p><input id="subject" name="subject" data-nv-draft-field /></form>',
        );
    }, alice);
    await expect.poll(() => page.inputValue('#subject')).toBe('Hello later');
    expect(await page.textContent('#later [data-nv-draft-status]')).toContain(
      'has not been sent',
    );
  });
});

describe('store policy', () => {
  it('expires drafts after the TTL and removes them', async () => {
    page = await open(alice, false);
    const result = await page.evaluate((scope) => {
      let clock = 1_000_000;
      const store = window.nvOffline.createDraftStore({
        scope,
        ttlMs: 60_000,
        now: () => clock,
      });
      store.save('product', { title: 'Old' });
      const fresh = store.load('product')?.fields;
      clock += 60_001;
      const expired = store.load('product');
      return { fresh, expired, remaining: localStorage.length };
    }, alice);
    expect(result.fresh).toEqual({ title: 'Old' });
    expect(result.expired).toBeNull();
    expect(result.remaining).toBe(0);
  });

  it('isolates scopes, purges foreign scopes and clears all on logout', async () => {
    page = await open(alice, false);
    const result = await page.evaluate(
      ({ alice, bob }) => {
        const a = window.nvOffline.createDraftStore({ scope: alice });
        const b = window.nvOffline.createDraftStore({ scope: bob });
        a.save('product', { title: 'Alice' });
        const crossLoad = b.load('product');
        localStorage.setItem('unrelated', 'kept');
        const purged = b.purge();
        const afterPurge = a.load('product');
        b.save('product', { title: 'Bob' });
        a.save('other', { title: 'Alice 2' });
        const cleared = window.nvOffline.clearAllDrafts();
        return {
          crossLoad,
          purged,
          afterPurge,
          cleared,
          keys: Object.keys(localStorage),
        };
      },
      { alice, bob },
    );
    expect(result.crossLoad).toBeNull();
    expect(result.purged).toBe(1);
    expect(result.afterPurge).toBeNull();
    expect(result.cleared).toBe(2);
    expect(result.keys).toEqual(['unrelated']);
  });

  it('rejects corrupt, prototype-key and oversize payloads without pollution', async () => {
    page = await open(alice, false);
    const result = await page.evaluate((scope) => {
      const key = `nv-draft:v1:${scope}:product`;
      const store = window.nvOffline.createDraftStore({ scope, maxBytes: 512 });
      const now = Date.now();
      const results: unknown[] = [];
      for (const raw of [
        '{not json',
        `{"v":1,"scope":"${scope}","form":"product","savedAt":${now},"expiresAt":${now + 1000},"fields":{"__proto__":{"polluted":true}}}`,
        `{"__proto__":{"polluted":true},"v":1,"scope":"${scope}","form":"product","savedAt":${now},"expiresAt":${now + 1000},"fields":{}}`,
        `{"v":1,"scope":"${scope}","form":"product","savedAt":${now},"expiresAt":${now + 1000},"fields":{"title":{"nested":1}}}`,
        `{"v":2,"scope":"${scope}","form":"product","savedAt":${now},"expiresAt":${now + 1000},"fields":{}}`,
        `{"v":1,"scope":"${scope}","form":"product","savedAt":${now},"expiresAt":${now + 1000},"fields":{"title":"${'x'.repeat(600)}"}}`,
      ]) {
        localStorage.setItem(key, raw);
        results.push(store.load('product'));
        results.push(localStorage.getItem(key));
      }
      let oversize = 'stored';
      store.save('product', { title: 'y'.repeat(600) });
      if (localStorage.getItem(key) === null) oversize = 'rejected';
      let invalidName = 'accepted';
      try {
        store.save('product', { ['__proto__']: 'x' } as Record<string, string>);
      } catch {
        invalidName = 'rejected';
      }
      let invalidForm = 'accepted';
      try {
        store.load('../escape');
      } catch {
        invalidForm = 'rejected';
      }
      return {
        results,
        polluted: Reflect.get({}, 'polluted'),
        oversize,
        invalidName,
        invalidForm,
      };
    }, alice);
    expect(result.results.every((value) => value === null)).toBe(true);
    expect(result.polluted).toBeUndefined();
    expect(result.oversize).toBe('rejected');
    expect(result.invalidName).toBe('rejected');
    expect(result.invalidForm).toBe('rejected');
  });

  it('degrades to a no-op when storage throws', async () => {
    page = await open(alice, false);
    const result = await page.evaluate((scope) => {
      const errors: string[] = [];
      const failing: Storage = {
        get length() {
          return 0;
        },
        key: () => null,
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('full', 'QuotaExceededError');
        },
        removeItem: () => undefined,
        clear: () => undefined,
      };
      const store = window.nvOffline.createDraftStore({
        scope,
        storage: failing,
        onError: (error) =>
          errors.push(error instanceof DOMException ? error.name : 'other'),
      });
      store.save('product', { title: 'Lost' });
      const loaded = store.load('product');
      return { errors, loaded };
    }, alice);
    expect(result.loaded).toBeNull();
    expect(result.errors).toEqual(['QuotaExceededError', 'SecurityError']);
  });
});

describe('reconnect flow', () => {
  it('marks an interrupted submit and only updates the message when online', async () => {
    page = await open();
    await page.fill('#title', 'Offline lamp');
    await page.click('#save');
    await page.evaluate(() => {
      document.querySelector('#component')?.dispatchEvent(
        new CustomEvent('nestvexa:error', {
          bubbles: true,
          detail: { code: 'NETWORK' },
        }),
      );
    });
    expect(await page.getAttribute('#product', 'data-nv-draft-state')).toBe(
      'interrupted',
    );
    expect(await page.textContent('[data-nv-draft-status]')).toContain(
      'Not sent',
    );
    expect((await stored(page))?.['fields']).toMatchObject({
      title: 'Offline lamp',
    });
    await page.focus('#notes');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(await page.getAttribute('#product', 'data-nv-draft-state')).toBe(
      'reconnected',
    );
    expect(await page.textContent('[data-nv-draft-status]')).toContain(
      'Review and submit again',
    );
    expect(await page.evaluate(() => window.nvDraftTest.submits)).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('notes');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.nvDraftTest.submits)).toBe(1);
  });

  it('ignores validation errors and errors without a submit attempt', async () => {
    page = await open();
    await page.fill('#title', 'Lamp');
    await page.evaluate(() => {
      const component = document.querySelector('#component');
      component?.dispatchEvent(
        new CustomEvent('nestvexa:error', {
          bubbles: true,
          detail: { code: 'NETWORK' },
        }),
      );
    });
    expect(
      await page.getAttribute('#product', 'data-nv-draft-state'),
    ).toBeNull();
    await page.click('#save');
    await page.evaluate(() => {
      document.querySelector('#component')?.dispatchEvent(
        new CustomEvent('nestvexa:error', {
          bubbles: true,
          detail: { code: 'RESPONSE' },
        }),
      );
    });
    expect(
      await page.getAttribute('#product', 'data-nv-draft-state'),
    ).toBeNull();
  });

  it('clears the draft when the server renders a committed marker', async () => {
    page = await open();
    await page.fill('#title', 'Committed lamp');
    await page.waitForFunction(() => localStorage.length === 1);
    await page.evaluate(() => {
      const target = document.querySelector('#product');
      if (target instanceof HTMLFormElement)
        window.nvOffline.markCommitted(target);
    });
    await page.waitForFunction(() => localStorage.length === 0);
    // A newer token after further typing clears again.
    await page.fill('#title', 'Second lamp');
    await page.waitForFunction(() => localStorage.length === 1);
    await page.evaluate(() => {
      document
        .querySelector('#product')
        ?.setAttribute('data-nv-draft-committed', 'revision-9');
    });
    await page.waitForFunction(() => localStorage.length === 0);
  });

  it('keeps drafts newer than a first-seen timestamp marker and clears older ones', async () => {
    page = await open(alice, false);
    const result = await page.evaluate((scope) => {
      const store = window.nvOffline.createDraftStore({ scope });
      const target = document.querySelector('#product');
      if (!(target instanceof HTMLFormElement)) throw new Error('missing form');
      store.save('product', { title: 'Newer than commit' });
      target.setAttribute(
        'data-nv-draft-committed',
        String(Date.now() - 60_000),
      );
      const kept = window.nvOffline.attachOfflineDrafts(document, { store });
      const keptValue = (document.querySelector('#title') as HTMLInputElement)
        .value;
      kept.dispose();
      (document.querySelector('#title') as HTMLInputElement).value = '';
      target.setAttribute(
        'data-nv-draft-committed',
        String(Date.now() + 60_000),
      );
      const cleared = window.nvOffline.attachOfflineDrafts(document, { store });
      const remaining = store.load('product');
      cleared.dispose();
      return { keptValue, remaining };
    }, alice);
    expect(result.keptValue).toBe('Newer than commit');
    expect(result.remaining).toBeNull();
  });

  it('stops saving after dispose', async () => {
    page = await open();
    await page.evaluate(() => window.nvDraftTest.controller?.dispose());
    await page.fill('#title', 'After dispose');
    await page.waitForTimeout(80);
    expect(await stored(page)).toBeNull();
  });
});

describe('logout clearing', () => {
  it('clears drafts and snapshots in every tab and suspends saving', async () => {
    const context = await fixture.browser.newContext();
    try {
      const first = await context.newPage();
      await first.goto(fixture.base);
      await first.waitForFunction(() => Reflect.has(window, 'nvOffline'));
      const second = await context.newPage();
      await second.goto(fixture.base);
      await second.waitForFunction(() => Reflect.has(window, 'nvOffline'));
      await second.evaluate((scope) => {
        Reflect.set(window, 'logouts', 0);
        window.addEventListener('nestvexa:logout', () =>
          Reflect.set(
            window,
            'logouts',
            Number(Reflect.get(window, 'logouts')) + 1,
          ),
        );
        window.nvOffline.listenForLogout();
        sessionStorage.setItem(`nv-snapshot:v1:${scope}:recent`, '{"v":1}');
      }, alice);
      await first.evaluate(
        ({ alice, bob }) => {
          window.nvOffline.createDraftStore({ scope: bob }).save('product', {
            title: 'Bob',
          });
          const store = window.nvOffline.createDraftStore({ scope: alice });
          Reflect.set(
            window,
            'controller',
            window.nvOffline.attachOfflineDrafts(document, {
              store,
              debounceMs: 50,
            }),
          );
        },
        { alice, bob },
      );
      await first.fill('#title', 'Pending at logout');
      await first.click('#logout-button');
      await first.waitForTimeout(120);
      expect(await first.evaluate(() => localStorage.length)).toBe(0);
      await expect
        .poll(() => second.evaluate(() => Reflect.get(window, 'logouts')))
        .toBe(1);
      expect(await second.evaluate(() => sessionStorage.length)).toBe(0);
      // Further typing after logout is not persisted on this page.
      await first.fill('#title', 'Typed after logout');
      await first.waitForTimeout(120);
      expect(await first.evaluate(() => localStorage.length)).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('clears drafts synchronously when a data-nv-logout form submits', async () => {
    page = await open();
    await page.fill('#title', 'Draft before logout');
    await page.waitForFunction(() => localStorage.length === 1);
    await page.click('#logout-submit');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(await page.evaluate(() => window.nvDraftTest.logouts)).toBe(1);
    expect(await page.evaluate(() => window.nvOffline.announceLogout())).toBe(
      0,
    );
  });
});
