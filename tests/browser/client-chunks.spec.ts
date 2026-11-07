import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// BROW-004 (ADR 0036): optional Live features load as separate chunks served
// by nestvexa/assets, only on pages whose markup or configuration uses them.

const chunks = /\/_nestvexa\/assets\/[a-f0-9]{64}\/(live-[a-z]+\.js)$/;
const chunksBase = exampleUrl('client-chunks', 3880);
const lab = exampleUrl('directive-lab', 3360);
const matrix = exampleUrl('integration-matrix', 3123);
const starter = exampleUrl('starter-live', 3102);
// Server round trips and chunk loads are slow on loaded hosts; wait on state.
const wait = expect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

/** Every Live feature chunk the page requests, in request order. */
function recordChunks(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    const match = chunks.exec(new URL(request.url()).pathname);
    if (match?.[1]) requested.push(match[1]);
  });
  return requested;
}
async function watchPolicy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    const errors: string[] = [];
    Reflect.set(window, 'chunkViolations', violations);
    Reflect.set(window, 'chunkErrors', errors);
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
    document.addEventListener('nestvexa:error', (event) => {
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : null;
      errors.push(
        String(
          detail && typeof detail === 'object'
            ? Reflect.get(detail, 'code')
            : 'unknown',
        ),
      );
    });
  });
}
async function violations(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(window, 'chunkViolations'));
}
async function order(page: Page, list: string): Promise<(string | null)[]> {
  return page
    .locator(`#${list} > li`)
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('nv:sort.item')),
    );
}

test.describe('canonical boot.js under a nonce-only policy with SRI import map', () => {
  test('a page without optional directives loads only the core entry', async ({
    page,
  }) => {
    await watchPolicy(page);
    const requested = recordChunks(page);
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script')
        scripts.push(new URL(request.url()).pathname.split('/').pop() ?? '');
    });
    await page.goto(chunksBase + '/');
    // A click before the client has mounted is an inert button press.
    await wait(async () => {
      await page.locator('#increment').click();
      await expect(page.locator('#count')).not.toHaveText('0', {
        timeout: 2_000,
      });
    }).toPass();
    expect(requested).toEqual([]);
    expect(scripts).toEqual(
      expect.arrayContaining(['boot.js', 'index.js', 'alpine.js']),
    );
    expect(await violations(page)).toEqual([]);
  });

  test('the sort chunk loads once, on demand, and connected lists and grids work against the server', async ({
    page,
  }) => {
    await watchPolicy(page);
    const requested = recordChunks(page);
    await page.goto(chunksBase + '/');
    await wait(page.locator('#count')).toHaveText('0');
    expect(requested).toEqual([]);
    await page.getByRole('link', { name: 'Sortable board' }).click();
    await wait(page.locator('#move-docs')).toHaveAttribute('draggable', 'true');
    expect(requested).toEqual(['live-sort.js']);
    // Within a column.
    await page.locator('#move-tests').press('Alt+ArrowDown');
    await wait
      .poll(() => order(page, 'todo'))
      .toEqual(['docs', 'audit', 'tests']);
    // Across connected columns: the server receives { item, lists }.
    await page.locator('#move-docs').press('Alt+Shift+ArrowRight');
    await wait.poll(() => order(page, 'done')).toEqual(['docs', 'ship']);
    await wait.poll(() => order(page, 'todo')).toEqual(['audit', 'tests']);
    // A native pointer drag onto the other column's free area appends.
    const done = await page.locator('#done').boundingBox();
    if (!done) throw new Error('Missing column geometry');
    await page.locator('#move-audit').dragTo(page.locator('#done'), {
      targetPosition: { x: done.width / 2, y: done.height - 6 },
    });
    await wait
      .poll(() => order(page, 'done'))
      .toEqual(['docs', 'ship', 'audit']);
    // A grid moves along rows with Left/Right and by a row with Up/Down.
    await page.locator('#photo-dunes').press('Alt+ArrowRight');
    await wait
      .poll(() => order(page, 'photos'))
      .toEqual(['harbor', 'dunes', 'forest', 'glacier', 'canyon', 'meadow']);
    await page.locator('#photo-dunes').press('Alt+ArrowDown');
    await wait
      .poll(() => order(page, 'photos'))
      .toEqual(['harbor', 'forest', 'glacier', 'canyon', 'dunes', 'meadow']);
    expect(requested).toEqual(['live-sort.js']);
    expect(await violations(page)).toEqual([]);
    expect(
      await page.evaluate(() => Reflect.get(window, 'chunkErrors')),
    ).toEqual([]);
  });

  test('a chunk whose bytes do not match its import-map integrity is refused', async ({
    page,
  }) => {
    await watchPolicy(page);
    let tampered = 0;
    await page.route(chunks, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      tampered++;
      // Still valid JavaScript: only the integrity digest differs.
      await route.fulfill({
        response,
        body: body.replace('Order updated for', 'Order changed for'),
      });
    });
    await page.goto(chunksBase + '/board');
    await wait
      .poll(() => page.evaluate(() => Reflect.get(window, 'chunkErrors')))
      .toEqual(['NETWORK']);
    expect(tampered).toBe(1);
    // The board was never registered: no sort controller, no handle state.
    await wait(page.locator('#move-docs')).not.toHaveAttribute(
      'draggable',
      'true',
    );
  });
});

test('strict self + Trusted Types: nv:navigate into a sortable page loads the chunk then', async ({
  page,
}) => {
  const requested = recordChunks(page);
  await page.goto(lab + '/about');
  await wait(page.locator('#about-title')).toBeVisible();
  expect(requested).toEqual([]);
  await page.locator('#home').click();
  await wait(page.locator('#move-alpha')).toHaveAttribute('draggable', 'true');
  expect(requested).toEqual(['live-sort.js']);
  await page.locator('#move-alpha').press('Alt+ArrowDown');
  await wait
    .poll(() => order(page, 'order'))
    .toEqual(['beta', 'alpha', 'gamma']);
  expect(
    await page.evaluate(() => Reflect.get(window, 'nvViolations')),
  ).toEqual([]);
});

test('upload and realtime transports load only on the pages that use them', async ({
  page,
}) => {
  const requested = recordChunks(page);
  await page.goto(matrix + '/counter');
  await wait(page.locator('[data-nv-component]').first()).toBeVisible();
  await page.goto(matrix + '/products');
  await wait(page.locator('input[type="file"]')).toBeVisible();
  await wait.poll(() => [...requested]).toEqual(['live-upload.js']);
  requested.length = 0;
  await page.goto(matrix + '/realtime');
  await wait.poll(() => [...requested]).toEqual(['live-realtime.js']);
});

test('stream and sort chunks load together for a panel that uses both', async ({
  page,
}) => {
  const requested = recordChunks(page);
  await page.goto(starter + '/');
  await wait(page.locator('[data-nv-component]').first()).toBeVisible();
  expect(requested).toEqual([]);
  await page.goto(starter + '/activity');
  await wait
    .poll(() => [...requested].sort())
    .toEqual(expect.arrayContaining(['live-sort.js', 'live-stream.js']));
  expect(requested).not.toContain('live-upload.js');
});
