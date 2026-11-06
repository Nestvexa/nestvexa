import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// examples/offline-progressive: @nestvexa/offline drafts, snapshots and the
// reconnect flow on a Live form that also works without JavaScript.
const base = exampleUrl('offline-progressive', 3122);
const createAction = '/_nestvexa/live/ticket-form/create';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/');
  await expect(page.locator('[data-nv-name="ticket-form"]')).toBeVisible();
  return errors;
}
function draftKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('nv-draft:')),
  );
}
function stored(page: Page): Promise<{ drafts: number; snapshots: number }> {
  return page.evaluate(() => ({
    drafts: Object.keys(localStorage).filter((key) =>
      key.startsWith('nv-draft:'),
    ).length,
    snapshots: Object.keys(sessionStorage).filter((key) =>
      key.startsWith('nv-snapshot:'),
    ).length,
  }));
}

test('restores an unsent draft after a reload but never stores the contact email', async ({
  page,
}) => {
  const errors = await open(page);
  await page.getByLabel('Subject').fill('Printer on floor 3');
  await page.getByLabel('Details').fill('It jams on every second page.');
  await page.getByLabel('Priority').selectOption('urgent');
  await page.getByLabel(/Contact email/).fill('pat@example.com');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  const saved = await page.evaluate(
    (key) => localStorage.getItem(key) ?? '',
    (await draftKeys(page))[0] ?? '',
  );
  expect(saved).toContain('Printer on floor 3');
  expect(saved).not.toContain('pat@example.com');
  expect(saved).not.toContain('_csrf');

  await page.reload();
  await expect(page.getByLabel('Subject')).toHaveValue('Printer on floor 3');
  await expect(page.getByLabel('Details')).toHaveValue(
    'It jams on every second page.',
  );
  await expect(page.getByLabel('Priority')).toHaveValue('urgent');
  await expect(page.getByLabel(/Contact email/)).toHaveValue('');
  await expect(page.locator('#ticket-draft-status')).toHaveText(
    'We restored your unsent draft from this device.',
  );

  // Submitting the restored draft sends the values and clears the draft.
  await page.getByLabel(/Contact email/).fill('pat@example.com');
  await page.getByRole('button', { name: 'Send ticket' }).click();
  await expect(page.locator('#ticket-status')).toHaveText(
    /Ticket #\d+ created\./,
  );
  await expect(page.getByLabel('Subject')).toHaveValue('');
  await expect.poll(() => draftKeys(page)).toHaveLength(0);
  await expect(page.locator('#recent-list')).toContainText(
    'Printer on floor 3 (urgent)',
  );
  expect(errors).toEqual([]);
});

test('an offline submit keeps the draft and nothing is resent on reconnect', async ({
  page,
  context,
}) => {
  await open(page);
  const creates: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === createAction)
      creates.push(request.method());
  });
  await page.getByLabel('Subject').fill('VPN drops at noon');
  await page.getByLabel('Details').fill('Every day around 12:00 for a minute.');
  await page.getByLabel(/Contact email/).fill('sam@example.com');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Send ticket' }).click();
  await expect(page.locator('#ticket-draft-status')).toHaveText(
    'Not sent. Your draft is saved on this device.',
  );
  await expect(page.locator('#ticket-form')).toHaveAttribute(
    'data-nv-draft-state',
    'interrupted',
  );
  // The advisory nv:offline hint is shown inside the component.
  await expect(page.locator('#ticket-connection')).toBeVisible();
  const attempts = creates.length;
  expect(attempts).toBeLessThanOrEqual(1);

  await context.setOffline(false);
  // Not every engine fires `online` for an emulated network change.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#ticket-draft-status')).toHaveText(
    'Connection restored. Reload the page to review your saved draft, then submit again.',
  );
  // No automatic replay: give a would-be retry time to happen.
  await page.waitForTimeout(1000);
  expect(creates.length).toBe(attempts);
  await expect(page.getByLabel('Subject')).toHaveValue('VPN drops at noon');
  expect(await draftKeys(page)).toHaveLength(1);
  await expect(page.locator('#recent-list')).toHaveCount(0);

  // The failed Live component is suspended until reconciled: a reload brings
  // back fresh server state and the draft; still nothing was sent.
  await page.reload();
  await expect(page.getByLabel('Subject')).toHaveValue('VPN drops at noon');
  await expect(page.getByLabel('Details')).toHaveValue(
    'Every day around 12:00 for a minute.',
  );
  // The contact email is not drafted; the user types it again.
  await expect(page.getByLabel(/Contact email/)).toHaveValue('');
  await expect(page.locator('#recent-empty')).toBeVisible();
  expect(creates.length).toBe(attempts);

  // The user decides to submit again: exactly one more request.
  await page.getByLabel(/Contact email/).fill('sam@example.com');
  await page.getByRole('button', { name: 'Send ticket' }).click();
  await expect(page.locator('#ticket-status')).toHaveText(
    /Ticket #\d+ created\./,
  );
  expect(creates.length).toBe(attempts + 1);
  await expect(page.locator('#recent-list li')).toHaveCount(1);
  await expect(page.locator('#ticket-connection')).toBeHidden();
});

test('shows a labelled, read-only copy of the ticket list while offline', async ({
  page,
  context,
}) => {
  await open(page);
  await page.getByLabel('Subject').fill('Badge reader broken');
  await page.getByLabel('Details').fill('The door on level 2 stays locked.');
  await page.getByLabel(/Contact email/).fill('kim@example.com');
  await page.getByRole('button', { name: 'Send ticket' }).click();
  await expect(page.locator('#recent-list li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Refresh tickets' }).click();
  await expect(page.locator('#recent-source')).toHaveText(
    'Tickets are up to date.',
  );

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh tickets' }).click();
  await expect(page.locator('#recent-source')).toHaveText(
    'You are offline. Showing a read-only copy saved on this device.',
  );
  const copy = page.getByRole('region', {
    name: /Offline copy of your tickets/,
  });
  await expect(copy).toBeVisible();
  await expect(copy).toContainText('Badge reader broken');
  await expect(copy.locator('time').first()).toHaveAttribute(
    'datetime',
    /\d{4}-\d{2}-\d{2}T/,
  );
  await expect(page.locator('#recent-tickets [inert]')).toHaveCount(1);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh tickets' }).click();
  await expect(page.locator('#recent-source')).toHaveText(
    'Tickets are up to date.',
  );
  await expect(
    page.locator('#recent-tickets [data-nv-offline-copy]'),
  ).toHaveCount(0);
});

test('signing out clears drafts and snapshots before the request leaves', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Subject').fill('Shared kiosk draft');
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  expect(await stored(page)).toEqual({ drafts: 1, snapshots: 1 });
  // Record storage at the end of the submit dispatch, after the
  // data-nv-logout handler ran and before the browser sends the request.
  // window.name survives the same-tab navigation that follows.
  await page.evaluate(() =>
    window.addEventListener('submit', () => {
      window.name = JSON.stringify({
        drafts: Object.keys(localStorage).filter((key) =>
          key.startsWith('nv-draft:'),
        ).length,
        snapshots: Object.keys(sessionStorage).filter((key) =>
          key.startsWith('nv-snapshot:'),
        ).length,
      });
    }),
  );
  await page
    .getByRole('button', { name: 'Sign out and clear this device' })
    .click();
  await page.waitForURL(base + '/');
  await expect(page.locator('#recent-empty')).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => window.name))).toEqual({
    drafts: 0,
    snapshots: 0,
  });
  await expect(page.getByLabel('Subject')).toHaveValue('');
  expect(await draftKeys(page)).toHaveLength(0);
});

test('a forged sign-out without the CSRF token is refused', async ({
  page,
}) => {
  await open(page);
  const response = await page.request.post(base + '/logout', {
    form: { _csrf: 'forged-token-value-forged-token-value-1234' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the same form validates on the server and succeeds through post/redirect/get', async ({
    page,
  }) => {
    await page.goto(base + '/');
    await expect(page.locator('#noscript-note')).toBeVisible();
    await page.getByLabel('Subject').fill('No');
    await page.getByLabel(/Contact email/).fill('not-an-email');
    await page.getByRole('button', { name: 'Send ticket' }).click();
    await expect(page).toHaveURL(base + '/');
    await expect(page.locator('#ticket-summary')).toBeVisible();
    await expect(page.locator('#ticket-subject-error')).toHaveText(
      'Enter a subject of at least 3 characters.',
    );
    await expect(page.locator('#ticket-contact-error')).toHaveText(
      'Enter a valid email address.',
    );
    await expect(page.getByLabel('Subject')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Old input comes back through the session (read once).
    await expect(page.getByLabel('Subject')).toHaveValue('No');

    await page.getByLabel('Subject').fill('Monitor flickers');
    await page
      .getByLabel('Details')
      .fill('The left screen flickers when cold.');
    await page.getByLabel('Priority').selectOption('low');
    await page.getByLabel(/Contact email/).fill('lee@example.com');
    await page.getByRole('button', { name: 'Send ticket' }).click();
    await expect(page).toHaveURL(base + '/');
    await expect(page.locator('#flash')).toContainText(/Ticket #\d+ created\./);
    await expect(page.locator('#recent-list')).toContainText(
      'Monitor flickers (low)',
    );
    await expect(page.locator('#ticket-summary')).toHaveCount(0);
    // A reload does not resubmit: the POST was answered with 303.
    await page.reload();
    await expect(page.locator('#recent-list li')).toHaveCount(1);
  });
});

test('the support page passes an accessibility scan @accessibility', async ({
  page,
}) => {
  // Two full axe scans: allow for slow shared CI hosts (WebKit especially).
  test.setTimeout(90_000);
  await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Also with visible validation errors.
  await page.getByRole('button', { name: 'Send ticket' }).click();
  await expect(page.locator('#ticket-summary')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
