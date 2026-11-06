import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exampleUrl } from './example-url.js';

const base = exampleUrl('multi-tenant', 3119);
const password = 'demo-password-2026';
const acmeNames = [
  'Warehouse robot firmware',
  'Assembly line audit',
  'Sensor calibration',
];
const globexNames = [
  'Route optimisation',
  'Fleet telematics rollout',
  'Depot safety review',
];

async function signIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#flash')).toContainText('Signed in as');
  return page;
}
async function openBoard(page: Page, tenant: string): Promise<Locator> {
  await page.goto(`${base}/t/${tenant}/projects`);
  const board = page.locator('[data-nv-name="tenant-board"]');
  await expect(board).toBeVisible();
  return board;
}
/** Snapshot reference and CSRF token rendered into a Live component root. */
async function liveReference(root: Locator) {
  return {
    snapshot: (await root.getAttribute('data-nv-snapshot')) ?? '',
    revision: Number(await root.getAttribute('data-nv-revision')),
    csrf: (await root.getAttribute('data-nv-csrf')) ?? '',
  };
}
/** A hand-built Live request, sent with the page's own cookies. */
function forge(
  page: Page,
  path: string,
  csrf: string,
  reference: { snapshot: string; revision: number },
  updates: Record<string, unknown> = {},
) {
  return page.request.post(base + path, {
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf,
    },
    data: JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId: randomUUID(),
      snapshot: reference.snapshot,
      revision: reference.revision,
      updates,
    }),
  });
}
async function apiNames(page: Page, tenant: string): Promise<string[]> {
  const reply = await page.request.get(`${base}/api/t/${tenant}/projects`);
  expect(reply.status()).toBe(200);
  const body = (await reply.json()) as { projects: { name: string }[] };
  return body.projects.map((project) => project.name);
}

test('guests see public workspace pages only and are sent to sign in', async ({
  page,
}) => {
  await page.goto(base + '/t/acme');
  await expect(page.locator('#tenant-tagline')).toHaveText(
    'Warehouse automation, one robot at a time.',
  );
  for (const name of acmeNames)
    expect(await page.content()).not.toContain(name);
  await page.goto(base + '/t/acme/projects');
  await expect(page).toHaveURL(base + '/login');
  const redirect = await page.request.get(base + '/t/acme/projects', {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(303);
  const api = await page.request.get(base + '/api/t/acme/projects');
  expect(api.status()).toBe(401);
  const text = await api.text();
  for (const name of acmeNames) expect(text).not.toContain(name);
  // A Live action without a member identity is refused before any component code.
  const live = await page.request.post(
    base + '/_nestvexa/live/tenant-board/create',
    {
      headers: { origin: base, 'content-type': 'application/json' },
      data: '{}',
    },
  );
  expect([401, 403]).toContain(live.status());
});

test('a member creates, validates, renames and toggles projects in their own workspace', async ({
  browser,
  browserName,
}) => {
  const page = await signIn(browser, 'max@acme.test');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const board = await openBoard(page, 'acme');
  await expect(board.locator('#board-role')).toHaveText('member');
  for (const name of acmeNames)
    await expect(board.getByRole('heading', { name })).toBeVisible();
  for (const name of globexNames)
    expect(await page.content()).not.toContain(name);
  // Members never see the admin-only delete control.
  await expect(board.getByRole('button', { name: /^Delete/ })).toHaveCount(0);

  await board.getByRole('button', { name: 'Create project' }).click();
  await expect(board.locator('#project-name-error')).toHaveText(
    'Use a project name of 2 to 60 characters.',
  );
  await board.getByLabel('Project name').fill('Sensor calibration');
  await board.getByRole('button', { name: 'Create project' }).click();
  await expect(board.locator('#project-name-error')).toHaveText(
    'This workspace already has a project with that name.',
  );
  const name = `Pilot ${browserName} ${Date.now()} <b>x</b>`;
  await board.getByLabel('Project name').fill(name);
  await board.getByRole('button', { name: 'Create project' }).click();
  await expect(board.locator('#board-message')).toHaveText(
    `${name} was created.`,
  );
  await expect(board.getByRole('heading', { name })).toBeVisible();
  await expect(board.locator('#project-list b')).toHaveCount(0);

  await board.getByRole('button', { name: `Rename ${name}` }).click();
  const renamed = `Renamed ${browserName} ${Date.now()}`;
  await board.getByLabel(`New name for ${name}`).fill(renamed);
  await board.getByRole('button', { name: 'Save name' }).click();
  await expect(board.getByRole('heading', { name: renamed })).toBeVisible();
  await board
    .getByRole('button', { name: `Toggle status of ${renamed}` })
    .click();
  const row = board.locator('article', {
    has: page.getByRole('heading', { name: renamed }),
  });
  await expect(row.locator('[id$="-status"]')).toHaveText('done');
  expect(await apiNames(page, 'acme')).toContain(renamed);
  expect(errors).toEqual([]);
  await page.context().close();
});

test('an admin deletes a project after confirmation', async ({
  browser,
  browserName,
}) => {
  const page = await signIn(browser, 'ada@acme.test');
  const board = await openBoard(page, 'acme');
  await expect(board.locator('#board-role')).toHaveText('admin');
  const name = `Disposable ${browserName} ${Date.now()}`;
  await board.getByLabel('Project name').fill(name);
  await board.getByRole('button', { name: 'Create project' }).click();
  await expect(board.getByRole('heading', { name })).toBeVisible();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(`Delete ${name}?`);
    void dialog.accept();
  });
  await board.getByRole('button', { name: `Delete ${name}` }).click();
  await expect(board.locator('#board-message')).toHaveText('Project deleted.');
  await expect(board.getByRole('heading', { name })).toHaveCount(0);
  expect(await apiNames(page, 'acme')).not.toContain(name);
  await page.context().close();
});

test('members of one tenant cannot read another tenant through pages or the API', async ({
  browser,
}) => {
  for (const [email, foreign, names] of [
    ['max@acme.test', 'globex', globexNames],
    ['liz@globex.test', 'acme', acmeNames],
  ] as const) {
    const page = await signIn(browser, email);
    const reply = await page.request.get(`${base}/t/${foreign}/projects`);
    expect(reply.status()).toBe(403);
    const html = await reply.text();
    for (const name of names) expect(html).not.toContain(name);
    expect(html).not.toContain('data-nv-snapshot');
    await page.goto(`${base}/t/${foreign}/projects`);
    await expect(page.locator('#forbidden-message')).toBeVisible();
    const api = await page.request.get(`${base}/api/t/${foreign}/projects`);
    expect(api.status()).toBe(403);
    const json = await api.text();
    for (const name of names) expect(json).not.toContain(name);
    await page.context().close();
  }
});

test('a Live snapshot from one account or tenant cannot be replayed by another', async ({
  browser,
  browserName,
}) => {
  const max = await signIn(browser, 'max@acme.test');
  const maxBoard = await liveReference(await openBoard(max, 'acme'));
  const liz = await signIn(browser, 'liz@globex.test');
  const lizBoard = await liveReference(await openBoard(liz, 'globex'));
  const stolen = `Stolen ${browserName} ${Date.now()}`;
  // Liz's own session cookie and CSRF token, Max's snapshot.
  const replay = await forge(
    liz,
    '/_nestvexa/live/tenant-board/create',
    lizBoard.csrf,
    maxBoard,
    { draftName: stolen },
  );
  expect(replay.status()).toBe(410);
  expect(await replay.json()).toMatchObject({ code: 'INVALID_SNAPSHOT' });
  expect(await apiNames(max, 'acme')).not.toContain(stolen);

  // Sam belongs to both tenants. Opening Globex rebinds his identity, so the
  // Acme snapshot he still holds cannot act on either tenant.
  const sam = await signIn(browser, 'sam@consult.test');
  const acmeSnapshot = await liveReference(await openBoard(sam, 'acme'));
  const globexBoard = await liveReference(await openBoard(sam, 'globex'));
  const crossed = await forge(
    sam,
    '/_nestvexa/live/tenant-board/create',
    globexBoard.csrf,
    acmeSnapshot,
    { draftName: stolen },
  );
  expect(crossed.status()).toBe(410);
  expect(await apiNames(sam, 'acme')).not.toContain(stolen);
  expect(await apiNames(sam, 'globex')).not.toContain(stolen);
  for (const page of [max, liz, sam]) await page.context().close();
});

test('a member cannot forge the admin-only delete action', async ({
  browser,
}) => {
  const max = await signIn(browser, 'max@acme.test');
  const board = await openBoard(max, 'acme');
  const row = board.locator('[data-nv-name="tenant-project"]').first();
  const reference = await liveReference(row);
  const forged = await forge(
    max,
    '/_nestvexa/live/tenant-project/remove',
    reference.csrf,
    reference,
  );
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toMatchObject({ code: 'ACTION_FORBIDDEN' });
  expect(await apiNames(max, 'acme')).toEqual(
    expect.arrayContaining(acmeNames.slice(0, 1)),
  );
  // A wrong CSRF token with a valid snapshot is refused as well.
  const noCsrf = await forge(
    max,
    '/_nestvexa/live/tenant-project/toggleStatus',
    'x'.repeat(43),
    reference,
  );
  expect(noCsrf.status()).toBe(403);
  await max.context().close();
});

test('accessibility: public, sign-in and member pages pass automated checks', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const guest = await context.newPage();
  for (const path of ['/', '/t/globex', '/login']) {
    await guest.goto(base + path);
    expect(
      (await new AxeBuilder({ page: guest }).analyze()).violations,
    ).toEqual([]);
  }
  await context.close();
  const max = await signIn(browser, 'max@acme.test');
  await openBoard(max, 'acme');
  expect((await new AxeBuilder({ page: max }).analyze()).violations).toEqual(
    [],
  );
  await max.goto(base + '/t/globex/projects');
  expect((await new AxeBuilder({ page: max }).analyze()).violations).toEqual(
    [],
  );
  await max.context().close();
});
