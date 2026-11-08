import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { labUrl, openLab, sameDocument } from './browser-lab.js';

// The real default boot module starts the bundled CSP Alpine 3.17 build and
// binds `$live` to the Live client; the lab page drives a real Nest component.

async function exercise(page: Page): Promise<void> {
  await expect(page.locator('#alpine-level')).toHaveText('1');
  await expect(page.locator('#alpine-received')).toHaveText('0');

  // $live.dispatch reaches the server's @OnEvent listener; $live.state reacts.
  await page.locator('#alpine-dispatch').click();
  await expect(page.locator('#received')).toHaveText('1');
  await expect(page.locator('#last')).toHaveText('from alpine');
  await expect(page.locator('#alpine-received')).toHaveText('1');
  // `$live.on('lab.pong')` ignores the dispatched `lab.ping` name.
  await expect(page.locator('#alpine-log')).toHaveText('');

  // A server-emitted event reaches $live.on with its source component.
  await page.locator('#announce').click();
  await expect(page.locator('#level')).toHaveText('2');
  await expect(page.locator('#alpine-level')).toHaveText('2');
  await expect(page.locator('#alpine-log')).toHaveText('lab-listener:level 2');

  // Unsubscribing stops delivery.
  await page.locator('#alpine-stop').click();
  await page.locator('#announce').click();
  await expect(page.locator('#level')).toHaveText('3');
  await expect(page.locator('#alpine-level')).toHaveText('3');
  await expect(page.locator('#alpine-log')).toHaveText('lab-listener:level 2');

  // $live.entangle: Alpine edits stage a draft that the next request sends;
  // the committed server value flows back into Alpine.
  await expect(page.locator('#entangled-input')).toHaveValue('Draft');
  await page.locator('#entangled-input').fill('Hello');
  await expect(page.locator('#entangled-title')).toHaveText('Hello');
  await expect(page.locator('#server-title')).toHaveText('Draft');
  await page.locator('#rename').click();
  await expect(page.locator('#server-title')).toHaveText('Hello!');
  await expect(page.locator('#entangled-input')).toHaveValue('Hello!');
  await expect(page.locator('#entangled-title')).toHaveText('Hello!');
  await page.locator('#rename').click();
  await expect(page.locator('#entangled-title')).toHaveText('Hello!!');
}

test('$live state, dispatch, on and entangle work with real Alpine on a loaded page', async ({
  page,
}) => {
  const errors = await openLab(page, '/alpine');
  await exercise(page);
  // $live.state is read-only from Alpine expressions.
  const write = await page.evaluate(async () => {
    const { app } = (await import('/_nestvexa/boot.js' as string)) as {
      app: {
        alpine: { $data(element: Element): Record<string, unknown> };
      };
    };
    const element = document.getElementById('alpine-events');
    if (!element) return 'missing';
    const live = app.alpine.$data(element)['$live'] as {
      state: Record<string, unknown>;
    };
    try {
      live.state['level'] = 99;
      return 'written';
    } catch (error) {
      return error instanceof Error ? error.message : 'thrown';
    }
  });
  expect(write).toContain('read-only');
  await expect(page.locator('#alpine-level')).toHaveText('3');
  expect(errors).toEqual([]);
});

test('$live helpers bind on pages reached through nv:navigate and rebind after Back', async ({
  page,
}) => {
  const errors = await openLab(page, '/');
  await page.getByRole('link', { name: 'Alpine' }).click();
  await expect(page).toHaveURL(labUrl + '/alpine');
  expect(await sameDocument(page)).toBe(true);
  await exercise(page);
  await page.goBack();
  await expect(page).toHaveURL(labUrl + '/');
  await page.goForward();
  await expect(page).toHaveURL(labUrl + '/alpine');
  // A fresh server render with fresh Alpine bindings.
  await expect(page.locator('#alpine-level')).toHaveText('1');
  await page.locator('#announce').click();
  await expect(page.locator('#alpine-log')).toHaveText('lab-listener:level 2');
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});
