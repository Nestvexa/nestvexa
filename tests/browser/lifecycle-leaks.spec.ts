import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openLab, sameDocument } from './browser-lab.js';

// Mount and release many components (each with a poll timer, an intersection
// observer, delegated listeners and an Alpine `$live` subtree) and prove that
// the runtime returns the handles it took. Every browser counts live handles
// through instrumented platform APIs; Chromium additionally checks the
// garbage-collected heap through the DevTools protocol.

interface Handles {
  /** Listeners registered on window and document (where leaks accumulate). */
  readonly globalListeners: number;
  /** Pending setTimeout/setInterval callbacks. */
  readonly timers: number;
  /** Mutation/Intersection/Resize observers observing at least one target. */
  readonly observers: number;
  /** `nestvexa:event` listeners on window (Alpine `$live.on` subscriptions). */
  readonly eventSubscriptions: number;
}

/** Installed before any page script: counts handles without retaining nodes. */
function instrument(): void {
  const listeners = new WeakMap<EventTarget, Set<string>>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const id = (value: object): number => {
    let found = ids.get(value);
    if (found === undefined) ids.set(value, (found = ++nextId));
    return found;
  };
  const key = (
    type: string,
    listener: unknown,
    options: boolean | EventListenerOptions | undefined,
  ): string =>
    `${type}|${listener && typeof listener === 'object' ? id(listener) : typeof listener === 'function' ? id(listener) : 0}|${typeof options === 'boolean' ? options : options?.capture === true}`;
  const counts = { global: 0, events: 0 };
  const global = (target: EventTarget) =>
    target === window || target === document;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (listener && global(this)) {
      const set = listeners.get(this) ?? new Set<string>();
      listeners.set(this, set);
      const entry = key(type, listener, options);
      if (!set.has(entry)) {
        set.add(entry);
        counts.global++;
        if (type === 'nestvexa:event') counts.events++;
      }
    }
    add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options,
  ) {
    const set = listeners.get(this);
    const entry = key(type, listener, options);
    if (set?.delete(entry)) {
      counts.global--;
      if (type === 'nestvexa:event') counts.events--;
    }
    remove.call(this, type, listener, options);
  };
  const timers = new Set<number>();
  const setTimer = window.setTimeout;
  const clearTimer = window.clearTimeout;
  const setRepeat = window.setInterval;
  const clearRepeat = window.clearInterval;
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest) => {
    const timer: number = setTimer(
      (...args: unknown[]) => {
        timers.delete(timer);
        if (typeof handler === 'function') handler(...args);
      },
      ms,
      ...rest,
    );
    timers.add(timer);
    return timer;
  }) as typeof window.setTimeout;
  window.clearTimeout = (timer?: number) => {
    if (timer !== undefined) timers.delete(timer);
    clearTimer(timer);
  };
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest) => {
    const timer = setRepeat(handler, ms, ...rest);
    timers.add(timer);
    return timer;
  }) as typeof window.setInterval;
  window.clearInterval = (timer?: number) => {
    if (timer !== undefined) timers.delete(timer);
    clearRepeat(timer);
  };
  let observing = 0;
  const active = new WeakSet<object>();
  for (const name of [
    'MutationObserver',
    'IntersectionObserver',
    'ResizeObserver',
  ] as const) {
    const prototype = window[name].prototype as {
      observe(...args: unknown[]): void;
      disconnect(): void;
      unobserve?(target: Element): void;
    };
    const targets = new WeakMap<object, number>();
    const observe = prototype.observe;
    const disconnect = prototype.disconnect;
    const unobserve = prototype.unobserve;
    prototype.observe = function (...args: unknown[]) {
      targets.set(this, (targets.get(this) ?? 0) + 1);
      if (!active.has(this)) {
        active.add(this);
        observing++;
      }
      observe.apply(this, args);
    };
    prototype.disconnect = function () {
      if (active.delete(this)) observing--;
      targets.delete(this);
      disconnect.call(this);
    };
    if (unobserve)
      prototype.unobserve = function (target: Element) {
        const left = (targets.get(this) ?? 1) - 1;
        targets.set(this, left);
        if (left <= 0 && active.delete(this)) observing--;
        unobserve.call(this, target);
      };
  }
  Reflect.set(window, 'nvHandles', () => ({
    globalListeners: counts.global,
    timers: timers.size,
    observers: observing,
    eventSubscriptions: counts.events,
  }));
}
const handles = (page: Page) =>
  page.evaluate(() => (Reflect.get(window, 'nvHandles') as () => Handles)());

/** Navigate with nv:navigate and wait until the page settled. */
async function go(page: Page, name: string, title: RegExp): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveTitle(title);
  await expect(page.locator('html')).not.toHaveAttribute('aria-busy', 'true');
  // Intersection callbacks and their `see` actions settle.
  await page.waitForTimeout(400);
}

test('navigating between many-component pages releases listeners, timers, observers and Alpine subscriptions', async ({
  page,
}) => {
  // Sixteen settled page swaps with twelve components each.
  test.setTimeout(120_000);
  await page.addInitScript(instrument);
  const errors = await openLab(page, '/many?count=12');
  await expect(page.locator('.cell')).toHaveCount(12);
  await expect(
    page.locator('.cell-sentinel', { hasText: 'seen' }).first(),
  ).toBeVisible();
  await page.waitForTimeout(400);
  const many = await handles(page);
  // Twelve cells: twelve poll timers and twelve `$live.on` subscriptions.
  expect(many.timers).toBeGreaterThanOrEqual(12);
  expect(many.eventSubscriptions).toBe(12);

  await go(page, 'Home', /^Browser lab$/);
  const home = await handles(page);
  expect(home.eventSubscriptions).toBe(0);
  expect(home.timers).toBeLessThanOrEqual(many.timers - 12);

  // Reference counts from the first revisit of each page (the first load
  // also holds one-off startup timers). In-flight requests hold transient
  // timeouts, so each later sample must settle back to its reference.
  const settled = (reference: Handles) =>
    expect.poll(() => handles(page), { timeout: 10_000 }).toEqual(reference);
  await go(page, 'Many', /^Many components/);
  await page.waitForTimeout(1000);
  const manyAgain = await handles(page);
  await go(page, 'Home', /^Browser lab$/);
  await page.waitForTimeout(1000);
  const homeAgain = await handles(page);
  expect(manyAgain.eventSubscriptions).toBe(12);
  expect(manyAgain.globalListeners).toBe(many.globalListeners);
  expect(homeAgain.eventSubscriptions).toBe(0);
  expect(homeAgain.timers).toBeLessThanOrEqual(manyAgain.timers - 12);
  for (let round = 0; round < 6; round++) {
    await go(page, 'Many', /^Many components/);
    await expect(page.locator('.cell')).toHaveCount(12);
    await settled(manyAgain);
    await go(page, 'Home', /^Browser lab$/);
    await settled(homeAgain);
  }
  expect(await sameDocument(page)).toBe(true);

  // Disposing the application releases every Live-owned handle; what remains
  // belongs to Alpine (which has no public stop API) and the instrumentation.
  await go(page, 'Many', /^Many components/);
  await page.evaluate(async () => {
    const { app } = (await import('/_nestvexa/boot.js' as string)) as {
      app: { dispose(): void };
    };
    app.dispose();
  });
  await expect
    .poll(async () => (await handles(page)).timers, { timeout: 10_000 })
    .toBe(0);
  const disposed = await handles(page);
  expect(disposed.eventSubscriptions).toBe(12);
  expect(disposed.observers).toBeLessThanOrEqual(1);
  expect(disposed.globalListeners).toBeLessThan(homeAgain.globalListeners);
  expect(errors).toEqual([]);
});

test('Chromium heap: released components are garbage collected', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'DevTools heap metrics are Chromium-only',
  );
  test.setTimeout(120_000);
  const errors = await openLab(page, '/many?count=12');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  async function measure(): Promise<Record<string, number>> {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(
      metrics
        .filter((metric) =>
          ['Nodes', 'JSEventListeners', 'JSHeapUsedSize'].includes(metric.name),
        )
        .map((metric) => [metric.name, metric.value]),
    );
  }
  async function cycle(): Promise<void> {
    await go(page, 'Home', /^Browser lab$/);
    await go(page, 'Many', /^Many components/);
    await expect(page.locator('.cell')).toHaveCount(12);
  }
  // Warm up caches and JIT, then compare a short and a long run.
  await cycle();
  await cycle();
  const early = await measure();
  for (let round = 0; round < 10; round++) await cycle();
  const late = await measure();
  // Twelve-cell pages: one page holds ~200 nodes. Ten more cycles must not
  // retain detached pages (which would add ~2000 nodes and their listeners).
  expect(late['Nodes'] ?? 0).toBeLessThan((early['Nodes'] ?? 0) + 150);
  expect(late['JSEventListeners'] ?? 0).toBeLessThanOrEqual(
    (early['JSEventListeners'] ?? 0) + 5,
  );
  expect(late['JSHeapUsedSize'] ?? 0).toBeLessThan(
    (early['JSHeapUsedSize'] ?? 0) * 1.5 + 2_000_000,
  );
  // Detached Live roots are not retained by the runtime.
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'HTMLDivElement.prototype',
  });
  if (!result.objectId) throw new Error('Missing prototype handle');
  const { objects } = await cdp.send('Runtime.queryObjects', {
    prototypeObjectId: result.objectId,
  });
  if (!objects.objectId) throw new Error('Missing query result');
  const { result: count } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId,
    functionDeclaration:
      'function () { return this.filter((node) => node.classList.contains("cell") && !node.isConnected).length; }',
    returnByValue: true,
  });
  expect(count.value).toBe(0);
  expect(errors).toEqual([]);
});
