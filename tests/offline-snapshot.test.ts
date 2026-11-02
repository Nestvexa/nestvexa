import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { startOfflineFixture } from './offline-support.js';
import type { OfflineFixture } from './offline-support.js';

const scope = 'scope-alice-0123456789';
const region = `
<section id="source">
  <div data-nv-component="c1" data-nv-snapshot="tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" data-nv-csrf="csrf-secret-token" nv:click="refresh">
    <h2 style="color:red">Recent activity</h2>
    <script>window.snapshotXss = true</script>
    <img src="/missing.png" alt="chart" onerror="window.snapshotXss = true">
    <a id="bad-link" href=" javascript:alert(1)">Bad</a>
    <a id="good-link" href="/products">Products</a>
    <iframe srcdoc="<script>parent.snapshotXss = true</script>"></iframe>
    <form action="/delete" data-nv-draft="x"><input type="hidden" name="_csrf" value="hidden-csrf-value"><button type="submit" formaction="/purge">Delete all</button><input name="q" value="lamp"></form>
    <ul><li>Lamp created</li><li>Chair archived</li></ul>
  </div>
</section>
<section id="target"><p>Loading…</p></section>`;

let fixture: OfflineFixture;
let page: Page;
beforeAll(async () => {
  fixture = await startOfflineFixture(region, {
    '/fragments/activity': {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '<ul id="fresh"><li>Fresh entry</li></ul><script>window.regionXss = true</script><img src="/x.png" alt="" onerror="window.regionXss = true"><div data-nv-component="live-child">kept marker</div>',
    },
    '/fragments/denied': {
      status: 401,
      type: 'text/html; charset=utf-8',
      body: '<p>Sign in</p>',
    },
    '/fragments/json': {
      status: 200,
      type: 'application/json',
      body: '{"html":"<p>no</p>"}',
    },
  });
});
afterEach(async () => {
  await page?.close();
});
afterAll(async () => {
  await fixture?.close();
});

describe('read-only snapshots', () => {
  it('stores sanitized HTML without scripts, handlers, Live markers or CSRF values', async () => {
    page = await fixture.page();
    const raw = await page.evaluate((scope) => {
      const cache = window.nvOffline.createSnapshotCache({ scope });
      const source = document.querySelector('#source');
      if (!source) throw new Error('missing source');
      cache.remember('activity', source);
      return sessionStorage.getItem(`nv-snapshot:v1:${scope}:activity`) ?? '';
    }, scope);
    expect(raw).toContain('Lamp created');
    for (const forbidden of [
      '<script',
      'onerror',
      'javascript:',
      'srcdoc',
      '<iframe',
      'data-nv-',
      'nv:click',
      'csrf-secret-token',
      'hidden-csrf-value',
      'tok_abcdefghij',
      'style=',
      'formaction',
      '/delete',
    ])
      expect(raw).not.toContain(forbidden);
    expect(raw).toContain('href=\\"/products\\"');
  });

  it('restores an inert, disabled, labelled copy with a saved-time banner', async () => {
    page = await fixture.page();
    const result = await page.evaluate((scope) => {
      const cache = window.nvOffline.createSnapshotCache({ scope });
      const source = document.querySelector('#source');
      const target = document.querySelector('#target');
      if (!source || !target) throw new Error('missing fixture');
      cache.remember('activity', source);
      const restored = cache.restore('activity', target, {
        label: 'Offline copy',
      });
      const wrapper = target.querySelector('[data-nv-offline-copy]');
      const body = wrapper?.querySelector('[aria-readonly="true"]');
      return {
        restored,
        label: wrapper?.getAttribute('aria-label'),
        role: wrapper?.getAttribute('role'),
        banner: wrapper?.querySelector('[data-nv-offline-banner]')?.textContent,
        datetime: wrapper?.querySelector('time')?.getAttribute('datetime'),
        inert: body instanceof HTMLElement && body.inert,
        disabled: [...target.querySelectorAll('button, input')].every((item) =>
          item.hasAttribute('disabled'),
        ),
        components: target.querySelectorAll('[data-nv-component]').length,
        scripts: target.querySelectorAll('script, iframe').length,
        xss: Reflect.get(window, 'snapshotXss'),
      };
    }, scope);
    expect(result.restored).toBe(true);
    expect(result.label).toBe('Offline copy');
    expect(result.role).toBe('region');
    expect(result.banner).toMatch(/^Offline copy /);
    expect(result.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.inert).toBe(true);
    expect(result.disabled).toBe(true);
    expect(result.components).toBe(0);
    expect(result.scripts).toBe(0);
    expect(result.xss).toBeUndefined();
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => Reflect.get(window, 'snapshotXss'))).toBe(
      undefined,
    );
    expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
  });

  it('re-sanitizes tampered storage and rejects expired or foreign records', async () => {
    page = await fixture.page();
    const result = await page.evaluate((scope) => {
      const key = `nv-snapshot:v1:${scope}:activity`;
      const now = Date.now();
      sessionStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          scope,
          key: 'activity',
          savedAt: now,
          expiresAt: now + 10_000,
          html: '<p id="tampered">Tampered</p><img src=x onerror="window.tamperXss=1"><div data-nv-component="x" data-nv-snapshot="t"></div><script>window.tamperXss=1</script>',
        }),
      );
      const target = document.querySelector('#target');
      if (!target) throw new Error('missing target');
      const cache = window.nvOffline.createSnapshotCache({ scope });
      const restored = cache.restore('activity', target);
      const html = target.innerHTML;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          scope,
          key: 'activity',
          savedAt: now - 20_000,
          expiresAt: now - 1,
          html: '<p>old</p>',
        }),
      );
      const expired = cache.restore('activity', target);
      const expiredRemoved = sessionStorage.getItem(key) === null;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          scope: 'scope-bob-000123456789',
          key: 'activity',
          savedAt: now,
          expiresAt: now + 10_000,
          html: '<p>bob</p>',
        }),
      );
      const foreign = cache.restore('activity', target);
      sessionStorage.setItem(key, '{"__proto__":{"polluted":1}}');
      const polluted = cache.restore('activity', target);
      return {
        restored,
        html,
        expired,
        expiredRemoved,
        foreign,
        polluted,
        pollution: Reflect.get({}, 'polluted'),
      };
    }, scope);
    expect(result.restored).toBe(true);
    expect(result.html).toContain('Tampered');
    expect(result.html).not.toContain('onerror');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('data-nv-component');
    expect(result.expired).toBe(false);
    expect(result.expiredRemoved).toBe(true);
    expect(result.foreign).toBe(false);
    expect(result.polluted).toBe(false);
    expect(result.pollution).toBeUndefined();
    expect(await page.evaluate(() => Reflect.get(window, 'tamperXss'))).toBe(
      undefined,
    );
  });

  it('skips oversize snapshots and clears by key or scope', async () => {
    page = await fixture.page();
    const result = await page.evaluate((scope) => {
      const errors: string[] = [];
      const cache = window.nvOffline.createSnapshotCache({
        scope,
        maxBytes: 1024,
        onError: (error) =>
          errors.push(error instanceof Error ? error.name : 'other'),
      });
      const big = document.createElement('div');
      big.textContent = 'x'.repeat(2000);
      cache.remember('big', big);
      const small = document.createElement('div');
      small.textContent = 'small';
      cache.remember('one', small);
      cache.remember('two', small);
      const before = sessionStorage.length;
      cache.clear('one');
      const afterOne = sessionStorage.length;
      cache.clear();
      return { errors, before, afterOne, after: sessionStorage.length };
    }, scope);
    expect(result.errors).toEqual(['RangeError']);
    expect(result.before).toBe(2);
    expect(result.afterOne).toBe(1);
    expect(result.after).toBe(0);
  });
});

describe('loadRegion', () => {
  it('loads from the network, then falls back to the read-only copy while offline', async () => {
    const context = await fixture.browser.newContext();
    try {
      page = await fixture.page(context);
      const first = await page.evaluate(async (scope) => {
        const cache = window.nvOffline.createSnapshotCache({ scope });
        const target = document.querySelector('#target');
        if (!target) throw new Error('missing target');
        const result = await window.nvOffline.loadRegion(
          target,
          '/fragments/activity',
          { cache, key: 'activity' },
        );
        return {
          result,
          fresh: target.querySelector('#fresh')?.textContent,
          scripts: target.querySelectorAll('script').length,
          handler: target.querySelector('img')?.hasAttribute('onerror'),
          liveMarker: target.querySelector('[data-nv-component]') !== null,
        };
      }, scope);
      expect(first).toEqual({
        result: 'network',
        fresh: 'Fresh entry',
        scripts: 0,
        handler: false,
        liveMarker: true,
      });
      await context.setOffline(true);
      const second = await page.evaluate(async (scope) => {
        const cache = window.nvOffline.createSnapshotCache({ scope });
        const target = document.querySelector('#target');
        if (!target) throw new Error('missing target');
        target.replaceChildren();
        const result = await window.nvOffline.loadRegion(
          target,
          '/fragments/activity',
          { cache, key: 'activity', label: 'Saved copy' },
        );
        return {
          result,
          text: target.textContent,
          copy: target.querySelector('[data-nv-offline-copy]') !== null,
          liveMarker: target.querySelector('[data-nv-component]') !== null,
        };
      }, scope);
      expect(second.result).toBe('cache');
      expect(second.copy).toBe(true);
      expect(second.text).toContain('Saved copy');
      expect(second.text).toContain('Fresh entry');
      expect(second.liveMarker).toBe(false);
      const empty = await page.evaluate(async () => {
        const cache = window.nvOffline.createSnapshotCache({
          scope: 'scope-nobody-0000000000',
        });
        const target = document.querySelector('#target');
        if (!target) throw new Error('missing target');
        return window.nvOffline.loadRegion(target, '/fragments/activity', {
          cache,
          key: 'activity',
        });
      });
      expect(empty).toBe('unavailable');
      expect(await page.evaluate(() => Reflect.get(window, 'regionXss'))).toBe(
        undefined,
      );
    } finally {
      await context.close();
    }
  });

  it('never falls back to a cached copy on HTTP errors or non-HTML responses', async () => {
    page = await fixture.page();
    const result = await page.evaluate(async (scope) => {
      const cache = window.nvOffline.createSnapshotCache({ scope });
      const target = document.querySelector('#target');
      const source = document.querySelector('#source');
      if (!target || !source) throw new Error('missing fixture');
      cache.remember('activity', source);
      const denied = await window.nvOffline.loadRegion(
        target,
        '/fragments/denied',
        { cache, key: 'activity' },
      );
      const json = await window.nvOffline.loadRegion(
        target,
        '/fragments/json',
        { cache, key: 'activity' },
      );
      return { denied, json, text: target.textContent?.trim() };
    }, scope);
    expect(result).toEqual({
      denied: 'unavailable',
      json: 'unavailable',
      text: 'Loading…',
    });
  });

  it('rejects cross-origin, protocol-relative and malformed region URLs', async () => {
    page = await fixture.page();
    const rejected = await page.evaluate(async (scope) => {
      const cache = window.nvOffline.createSnapshotCache({ scope });
      const target = document.querySelector('#target');
      if (!target) throw new Error('missing target');
      const outcomes: string[] = [];
      for (const url of [
        '//evil.example/x',
        'https://evil.example/x',
        'fragments/activity',
        '/\\evil.example',
        '/frag\nments',
        'javascript:alert(1)',
      ]) {
        try {
          await window.nvOffline.loadRegion(target, url, {
            cache,
            key: 'activity',
          });
          outcomes.push('loaded');
        } catch (error) {
          outcomes.push(error instanceof TypeError ? 'rejected' : 'other');
        }
      }
      return outcomes;
    }, scope);
    expect(rejected).toEqual(Array(6).fill('rejected'));
  });
});
