import { expect, test } from '@playwright/test';

test('a renderless action updates bound text from state without morphing server HTML', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:3102/activity');
  await expect(page.locator('#activity-appearances')).toHaveText('1');
  // A browser-local marker inside server-rendered markup. A full HTML morph
  // restores the server text; a state-only acknowledgement leaves it alone.
  await page
    .locator('#activity-query')
    .evaluate((element) => element.setAttribute('data-local-marker', 'kept'));
  // Capture the reply through a pass-through route: Chromium may evict a
  // response body once later traffic arrives, so reading it afterwards races.
  let capabilities: string | undefined;
  let captured: unknown;
  await page.route('**/_nestvexa/live/activity-panel/like', async (route) => {
    capabilities = route.request().headers()['x-nestvexa-capabilities'];
    const response = await route.fetch();
    captured ??= await response.json();
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Like activity' }).click();
  await expect.poll(() => captured).toBeDefined();
  expect(capabilities).toBe('renderless-v1');
  const body = captured as {
    html: string;
    renderless?: boolean;
    state: { likes: number };
  };
  expect(body).toMatchObject({ html: '', renderless: true });
  expect(body.state.likes).toBe(1);
  await expect(page.locator('#activity-likes')).toHaveText('1');
  await expect(page.locator('#activity-query')).toHaveAttribute(
    'data-local-marker',
    'kept',
  );
  await page.getByRole('button', { name: 'Like activity' }).click();
  await expect(page.locator('#activity-likes')).toHaveText('2');
  // An ordinary action after renderless acknowledgements uses the newest
  // snapshot and receives fully rendered HTML.
  await page.getByRole('button', { name: 'Toggle activity detail' }).click();
  await expect(page.locator('#activity-likes')).toHaveText('2');
  await expect(page.locator('#activity-query')).not.toHaveAttribute(
    'data-local-marker',
    'kept',
  );
  expect(errors).toEqual([]);
});
