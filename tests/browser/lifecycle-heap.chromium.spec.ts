import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openLab } from './browser-lab.js';

// DevTools heap metrics exist only in Chromium. The `*.chromium.spec.ts`
// suffix keeps this file out of the Firefox and WebKit projects
// (playwright.config.ts), so it runs where it can instead of reporting skips.

async function go(page: Page, name: string, title: RegExp): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveTitle(title);
  await expect(page.locator('html')).not.toHaveAttribute('aria-busy', 'true');
  // Intersection callbacks and their `see` actions settle.
  await page.waitForTimeout(400);
}

test('Chromium heap: released components are garbage collected', async ({
  page,
}) => {
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
