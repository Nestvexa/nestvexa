import { expect, test } from '@playwright/test';

const base = 'http://127.0.0.1:3111';
const route = (action: string) => `${base}/_nestvexa/actions/cart/${action}`;

test('typed server actions succeed when authorized and fail without sign-in, CSRF or origin', async ({
  page,
}, testInfo) => {
  // Carts are keyed by the signed-in subject; one user per browser project.
  const user = testInfo.project.name.replace(/[^a-z]/gi, '').slice(0, 20);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/`);
  await expect(page.locator('#session')).toContainText('guest');

  // Guest session: admission passes, the group's SessionAuthGuard denies.
  const denied = page.waitForResponse(route('add-item'));
  await page.getByRole('button', { name: 'Add a Nest mug' }).click();
  const deniedResponse = await denied;
  expect(deniedResponse.status()).toBe(401);
  expect(await deniedResponse.json()).toMatchObject({
    protocol: 'nestvexa-actions/1',
    ok: false,
    error: { code: 'UNAUTHENTICATED' },
  });
  await expect(page.locator('#status')).toHaveText('Sign in to use the cart.');
  await expect(page.locator('#cart-lines li')).toHaveCount(0);

  await page.getByLabel('Name').fill(user);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#session')).toContainText(`user:${user}`);

  const added = page.waitForResponse(route('add-item'));
  await page.getByRole('button', { name: 'Add a Nest mug' }).click();
  const response = await added;
  expect(response.status()).toBe(200);
  const headers = response.request().headers();
  expect(headers['x-nestvexa-csrf']).toMatch(/^[\w-]{43}$/);
  expect(headers['idempotency-key']).toMatch(/^[\w-]{16,128}$/);
  expect(headers['content-type']).toBe('application/json');
  expect(await response.json()).toMatchObject({
    ok: true,
    data: {
      owner: `user:${user}`,
      lines: [{ productId: 'nest-mug', quantity: 1 }],
      totalCents: 1200,
    },
  });
  await expect(page.locator('#cart-lines li')).toHaveText(['1 × Nest mug']);
  await expect(page.locator('#cart-total')).toHaveText('12.00');
  await page.getByRole('button', { name: 'Add a Vexa shirt' }).click();
  await expect(page.locator('#cart-total')).toHaveText('37.00');

  // A same-origin script without the CSRF header is rejected.
  const withoutCsrf = await page.evaluate(async () => {
    const reply = await fetch('/_nestvexa/actions/cart/summary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: reply.status, body: (await reply.json()) as unknown };
  });
  expect(withoutCsrf).toMatchObject({
    status: 403,
    body: { ok: false, error: { code: 'FORBIDDEN', reason: 'CSRF' } },
  });
  const forged = await page.evaluate(async () => {
    const reply = await fetch('/_nestvexa/actions/cart/add-item', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nestvexa-csrf': 'forged-token-forged-token-forged-token-forg',
        'idempotency-key': 'forged-request-0000001',
      },
      body: JSON.stringify({ input: { productId: 'nest-mug', quantity: 5 } }),
    });
    return reply.status;
  });
  expect(forged).toBe(403);

  // The session cookie and a valid token are not enough from another origin.
  const csrf = await page
    .locator('meta[name="nestvexa-csrf"]')
    .getAttribute('content');
  const crossOrigin = await page.request.post(route('summary'), {
    headers: {
      origin: 'http://evil.example',
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf ?? '',
    },
    data: '{}',
  });
  expect(crossOrigin.status()).toBe(403);
  expect(await crossOrigin.json()).toMatchObject({
    error: { code: 'FORBIDDEN', reason: 'ORIGIN' },
  });

  // Rejected calls had no effect; the cart survives a reload.
  await page.reload();
  await expect(page.locator('#cart-total')).toHaveText('37.00');
  await expect(page.locator('#cart-lines li')).toHaveText([
    '1 × Nest mug',
    '1 × Vexa shirt',
  ]);
  await page.getByRole('button', { name: 'Clear cart' }).click();
  await expect(page.locator('#status')).toHaveText('Cart cleared');
  await expect(page.locator('#cart-total')).toHaveText('0.00');
  expect(errors).toEqual([]);
});
