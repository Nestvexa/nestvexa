/**
 * Layout-shift measurement (BROW-008) in real Chromium with the Layout
 * Instability API (`PerformanceObserver` type `layout-shift`; Firefox and
 * WebKit do not implement it). Updates are started programmatically through
 * `client.call`, so shifts are not excluded as `hadRecentInput`, and the
 * score sums every shift after mount (a session-window upper bound of CLS).
 * A positive control proves the probe sees real shifts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import {
  mountMatrix,
  openPage,
  releaseAll,
  startMatrix,
} from './support/live-matrix.js';
import type { MatrixComponent, MatrixFixture } from './support/live-matrix.js';

declare global {
  interface Window {
    nvShift: { score: number; count: number; since: number };
  }
}

let fixture: MatrixFixture;
let page: Page | undefined;
beforeAll(async () => {
  fixture = await startMatrix('chromium');
});
afterEach(async () => {
  await page?.evaluate(() => window.nvHarness?.client.dispose());
  await page?.close();
  page = undefined;
});
afterAll(async () => {
  await fixture?.close();
});

async function measure(
  component: MatrixComponent,
  calls: readonly string[],
  hold = false,
): Promise<{ score: number; count: number }> {
  page = await openPage(fixture);
  const target = page;
  await mountMatrix(target, component);
  await target.evaluate(() => {
    window.nvShift = { score: 0, count: 0, since: performance.now() };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const value: unknown = Reflect.get(entry, 'value');
        if (
          entry.startTime >= window.nvShift.since &&
          Reflect.get(entry, 'hadRecentInput') !== true &&
          typeof value === 'number'
        ) {
          window.nvShift.score += value;
          window.nvShift.count++;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  for (const action of calls) {
    await target.evaluate(
      (name) =>
        void window.nvHarness.client
          .call(window.nvHarness.root, name)
          .catch(() => undefined),
      action,
    );
    if (hold) {
      await target.waitForTimeout(400);
      await releaseAll(target);
    }
    await target.waitForTimeout(150);
  }
  // Two frames let the observer deliver the last entries.
  await target.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return target.evaluate(() => ({
    score: window.nvShift.score,
    count: window.nvShift.count,
  }));
}

const body =
  '<p>Paragraph one with enough text to occupy a line.</p><p>Paragraph two follows below.</p>';

describe('layout shift during Live updates (Chromium Layout Instability API)', () => {
  it('positive control: a server response inserting content above shifts the page', async () => {
    const result = await measure(
      {
        state: { banner: false },
        actions: { show: { toggle: 'banner' } },
        html: `{{#banner}}<div style="height:200px">New banner</div>{{/banner}}${body}`,
      },
      ['show'],
    );
    expect(result.count).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0.01);
  });

  it('keeps in-place text morphs at zero layout shift across repeated updates', async () => {
    const result = await measure(
      {
        state: { count: 0 },
        actions: { increment: { increment: 'count' } },
        html: `<p>Count <output id="count" style="display:inline-block;min-width:4ch">{{count}}</output></p>${body}`,
      },
      ['increment', 'increment', 'increment', 'increment', 'increment'],
    );
    expect(result).toEqual({ score: 0, count: 0 });
  });

  it('keeps nv:loading class indicators and aria-busy at zero shift while work is pending', async () => {
    const result = await measure(
      {
        state: { count: 0 },
        actions: { increment: { increment: 'count', hold: true } },
        html: `<p nv:loading.class="busy" style="height:1.5em">Status <output>{{count}}</output></p>${body}`,
      },
      ['increment', 'increment'],
      true,
    );
    expect(result).toEqual({ score: 0, count: 0 });
  });

  it('keeps a delayed indicator in reserved space at zero shift', async () => {
    const result = await measure(
      {
        state: { count: 0 },
        actions: { increment: { increment: 'count', hold: true } },
        html: `<div style="height:2em;position:relative"><span nv:loading.delay.100ms hidden style="position:absolute">Saving…</span></div>${body}`,
      },
      ['increment'],
      true,
    );
    expect(result).toEqual({ score: 0, count: 0 });
  });

  it('keeps a retained scroll container stable when its content is morphed', async () => {
    const rows = Array.from(
      { length: 40 },
      (_, index) => `<p style="height:24px;margin:0">Row ${index}</p>`,
    ).join('');
    const result = await measure(
      {
        state: { count: 0 },
        actions: { increment: { increment: 'count' } },
        rootClass: 'scroller',
        html: `<output>{{count}}</output>${rows}`,
      },
      ['increment', 'increment', 'increment'],
    );
    expect(result).toEqual({ score: 0, count: 0 });
  });
});
