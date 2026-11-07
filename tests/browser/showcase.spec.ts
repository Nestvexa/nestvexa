import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { exampleUrl } from './example-url.js';

/*
 * examples/showcase: one Nest application, signed-in users of two workspaces,
 * every page exercised through the browser. Data persists for the server's
 * lifetime and three browser projects share it, so tests use unique titles
 * and assert relative changes.
 */
const base = exampleUrl('showcase', 3124);
const password = 'showcase-demo-2026';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('showcase-avatar-image'),
]);
// Sign-in uses scrypt by design and several tests open more than one account.
test.describe.configure({ timeout: 180_000 });

async function axe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}
interface Session {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly errors: string[];
}
async function signIn(
  browser: Browser,
  email: string,
  options: { javaScriptEnabled?: boolean } = {},
): Promise<Session> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.flash').first()).toContainText('Signed in as');
  return { context, page, errors };
}
/** Opens the dashboard and waits until its realtime stream is connected. */
async function openDashboard(page: Page): Promise<void> {
  const stream = page.waitForResponse((response) =>
    response.url().includes('/_nestvexa/realtime/sse?'),
  );
  await page.goto(base + '/app');
  expect((await stream).status()).toBe(200);
}
const number = async (locator: Locator) => Number(await locator.textContent());
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
  reference: { snapshot: string; revision: number; csrf: string },
  updates: Record<string, unknown> = {},
) {
  return page.request.post(base + path, {
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-nestvexa-csrf': reference.csrf,
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

test('the public landing page is search friendly and members-only pages need a sign-in', async ({
  page,
  request,
}) => {
  await page.goto(base + '/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Nestvexa Showcase',
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /team workspace/,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/$/,
  );
  await expect(page.locator('#workspace-list li')).toHaveCount(2);
  await axe(page);
  for (const path of ['/app', '/app/tasks', '/app/profile', '/insights']) {
    await page.goto(base + path);
    await expect(page).toHaveURL(base + '/login');
  }
  await axe(page);
  // The native REST API answers guests with Nest's own 401.
  expect((await request.get(base + '/api/tasks')).status()).toBe(401);
  const health = (await (
    await request.get(base + '/api/health')
  ).json()) as Record<string, unknown>;
  expect(health).toMatchObject({ status: 'ok', mail: 'memory' });
});

test('sign-in shows one generic error for a wrong password and regenerates the session', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + '/login');
  const before = (await context.cookies()).find(
    (cookie) => cookie.name === 'showcase.sid',
  )?.value;
  await page.getByLabel('Email').fill('ben@harbor.test');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-summary')).toContainText(
    'The email or password is incorrect.',
  );
  await expect(page.getByLabel('Email')).toHaveValue('ben@harbor.test');
  await expect(page.getByLabel('Password')).toHaveValue('');
  await axe(page);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(base + '/app');
  await expect(page.locator('#who')).toHaveText('Ben Ortiz (member)');
  const after = (await context.cookies()).find(
    (cookie) => cookie.name === 'showcase.sid',
  )?.value;
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
  await context.close();
});

test('dashboard metrics update in realtime for the same workspace only, and the island keeps its state', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const ben = await signIn(browser, 'ben@harbor.test');
  const cleo = await signIn(browser, 'cleo@summit.test');
  for (const session of [ada, ben, cleo]) await openDashboard(session.page);

  // The island was server-rendered and hydrated; switch it to the 4-week range.
  const chart = ada.page.locator('[data-nv-island="throughput-chart"]');
  await expect(chart).toHaveAttribute('data-nv-ssr', /.*/);
  await expect(chart.locator('.island-chart')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await chart.locator('#chart-range-recent').click();
  await expect(chart.locator('#chart-range-recent')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(chart.locator('#dashboard-chart-table tbody tr')).toHaveCount(4);
  await ada.page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));

  const adaBefore = await number(ada.page.locator('#metric-deployments'));
  const cleoBefore = await number(cleo.page.locator('#metric-deployments'));
  await ben.page.getByRole('button', { name: 'Log a deployment' }).click();
  await expect(ben.page.locator('#metrics-notice')).toHaveText(
    'Deployment logged.',
  );
  // Ada's panel refreshed through her own authorized request, same document.
  await expect(ada.page.locator('#metric-deployments')).toHaveText(
    String(adaBefore + 1),
  );
  await expect(ada.page.locator('#metric-last')).toContainText(
    'Ben Ortiz logged a deployment',
  );
  expect(
    await ada.page.evaluate(() => Reflect.get(window, 'nvSameDocument')),
  ).toBe(true);
  // The island was not re-rendered by the Live update.
  await expect(chart.locator('#chart-range-recent')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(chart.locator('#dashboard-chart-table tbody tr')).toHaveCount(4);
  // Presence on this instance lists both Harbor members.
  await expect(ada.page.locator('#presence-list')).toContainText('Ben Ortiz');
  // Another workspace never hears about it.
  await ada.page.waitForTimeout(500);
  await expect(cleo.page.locator('#metric-deployments')).toHaveText(
    String(cleoBefore),
  );
  await expect(cleo.page.locator('#metric-last')).not.toContainText(
    'Ben Ortiz',
  );
  await axe(ada.page);
  for (const session of [ada, ben, cleo]) {
    expect(session.errors).toEqual([]);
    await session.context.close();
  }
});

test('realtime tokens only name channels the identity may read, and a stolen token is refused', async ({
  browser,
}) => {
  const ben = await signIn(browser, 'ben@harbor.test');
  const cleo = await signIn(browser, 'cleo@summit.test');
  await openDashboard(ben.page);
  await openDashboard(cleo.page);
  const panel = ben.page.locator('[data-nv-name="metrics-panel"]');
  const token = (await panel.getAttribute('data-nv-realtime')) ?? '';
  const [body] = token.split('.');
  const claims = JSON.parse(
    Buffer.from(body ?? '', 'base64url').toString('utf8'),
  ) as {
    c: string[];
  };
  expect(claims.c.sort()).toEqual(['metrics:harbor', 'notify:u-ben']);
  // Cleo replays Ben's token with her own cookies: refused.
  const stolen = await cleo.page.request.get(
    `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
  );
  expect(stolen.status()).toBe(403);
  // A guest has no realtime identity at all.
  const guest = await browser.newContext();
  const anonymous = await guest.request.get(
    `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
  );
  expect([401, 403]).toContain(anonymous.status());
  for (const context of [ben.context, cleo.context, guest])
    await context.close();
});

test('an admin creates a task with an attachment; the assignee gets a realtime notification and an email', async ({
  browser,
  browserName,
}) => {
  const title = `Prepare ${browserName} release notes ${Date.now().toString(36)}`;
  const ben = await signIn(browser, 'ben@harbor.test');
  await openDashboard(ben.page);
  const ada = await signIn(browser, 'ada@harbor.test');
  await ada.page.goto(base + '/app/tasks');
  await ada.page.getByRole('button', { name: 'New task' }).click();
  const dialog = ada.page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  // Server validation first: too short, and a malformed date.
  await dialog.getByLabel('Title').fill('ab');
  await dialog.getByLabel(/Due date/).fill('2026-02-30');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(dialog.locator('#task-error-summary')).toContainText(
    'Enter at least 3 characters.',
  );
  await expect(dialog.locator('#task-error-summary')).toContainText(
    'Enter a real date',
  );
  await expect(dialog.getByLabel('Title')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await axe(ada.page);
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel(/Due date/).fill('2026-12-01');
  await dialog.getByLabel('Assignee').selectOption({ label: 'Ben Ortiz' });
  await dialog.getByLabel(/Attachment/).setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`Release notes for ${title}\n`),
  });
  await expect(dialog.locator('#task-attachment-status')).toContainText(
    // The client reports "Uploading n%" first; wait for the finished upload.
    'Uploaded 1 file',
  );
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(ada.page.locator('#task-notice')).toHaveText(
    `Created “${title}”.`,
  );
  await expect(dialog).toBeHidden();
  await expect(ada.page.locator('#task-new')).toBeFocused();

  // Realtime notification on Ben's dashboard, without a reload.
  await expect(ben.page.locator('#inbox')).toContainText(
    `Ada Park assigned you “${title}”`,
  );
  // Email through @nestvexa/mail's test transport.
  await ben.page.goto(base + '/app/outbox');
  const mail = ben.page.locator('.mail', { hasText: title }).first();
  await expect(mail.locator('.mail-subject')).toHaveText(
    `Ada Park assigned you “${title}”`,
  );
  await expect(mail.locator('.mail-text')).toContainText('/app/tasks');
  await axe(ben.page);

  // The attachment downloads for workspace members.
  const tasks = (await (
    await ben.page.request.get(base + '/api/tasks')
  ).json()) as {
    tasks: { id: string; title: string; hasAttachment: boolean }[];
  };
  const created = tasks.tasks.find((task) => task.title === title);
  expect(created?.hasAttachment).toBe(true);
  const download = await ben.page.request.get(
    `${base}/app/tasks/${created?.id ?? ''}/attachment`,
  );
  expect(download.status()).toBe(200);
  expect(await download.text()).toContain(title);
  expect(download.headers()['content-disposition']).toContain('attachment');

  // Another workspace cannot see, fetch or download it (404, no oracle).
  const cleo = await signIn(browser, 'cleo@summit.test');
  const theirs = (await (
    await cleo.page.request.get(base + '/api/tasks')
  ).json()) as {
    workspace: string;
    tasks: { title: string }[];
  };
  expect(theirs.workspace).toBe('summit');
  expect(theirs.tasks.map((task) => task.title)).not.toContain(title);
  expect(
    (
      await cleo.page.request.get(`${base}/api/tasks/${created?.id ?? ''}`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await cleo.page.request.get(
        `${base}/app/tasks/${created?.id ?? ''}/attachment`,
      )
    ).status(),
  ).toBe(404);
  await cleo.page.goto(base + '/app/outbox');
  await expect(cleo.page.locator('#outbox-list')).not.toContainText(title);
  for (const session of [ada, ben, cleo]) {
    expect(session.errors).toEqual([]);
    await session.context.close();
  }
});

test('the task board searches, filters, sorts and pages; the dialog is keyboard friendly', async ({
  browser,
}) => {
  const dev = await signIn(browser, 'dev@summit.test');
  const page = dev.page;
  await page.goto(base + '/app/tasks');
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  await page.getByLabel('Search title or assignee').fill('rig');
  await expect(page).toHaveURL(/q=rig/);
  await expect(page.locator('#task-list')).toContainText(
    'Calibrate the test rig',
  );
  await expect(page.locator('#task-list article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Status').selectOption('done');
  await expect(page.locator('#task-list')).toContainText('Order spare sensors');
  await page.getByLabel('Status').selectOption('all');
  await page
    .getByLabel('Search title or assignee')
    .fill('no such task anywhere');
  await expect(page.locator('#task-empty')).toHaveText(
    'No tasks match these filters.',
  );
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Title', exact: true }).click();
  await expect(page.locator('#task-sort')).toHaveText('title asc');
  await expect(
    page.getByRole('button', { name: 'Title', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  // A member sees no delete buttons.
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);

  // Escape closes the dialog and focus returns to the opener.
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#task-new')).toBeFocused();
  await axe(page);
  expect(dev.errors).toEqual([]);
  await dev.context.close();
});

test('roles are enforced on the server: a member cannot forge the admin-only delete, and snapshots do not cross accounts', async ({
  browser,
}) => {
  const ben = await signIn(browser, 'ben@harbor.test');
  await ben.page.goto(base + '/app/tasks');
  const row = ben.page.locator('[data-nv-name="task-row"]').first();
  const reference = await liveReference(row);
  const forged = await forge(
    ben.page,
    '/_nestvexa/live/task-row/remove',
    reference,
  );
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toMatchObject({ code: 'ACTION_FORBIDDEN' });
  // Cleo replays Ben's row snapshot with her own cookies and CSRF token.
  const cleo = await signIn(browser, 'cleo@summit.test');
  await cleo.page.goto(base + '/app/tasks');
  const own = await liveReference(
    cleo.page.locator('[data-nv-name="task-board"]'),
  );
  const replay = await forge(cleo.page, '/_nestvexa/live/task-row/toggleDone', {
    ...reference,
    csrf: own.csrf,
  });
  expect(replay.status()).toBe(410);
  expect(await replay.json()).toMatchObject({ code: 'INVALID_SNAPSHOT' });
  // A wrong CSRF token with a valid snapshot is refused as well.
  const noCsrf = await forge(ben.page, '/_nestvexa/live/task-row/toggleDone', {
    ...reference,
    csrf: 'x'.repeat(43),
  });
  expect(noCsrf.status()).toBe(403);
  // Inertia: a member cannot create goals (native guard metadata), and the XSRF header is required.
  await ben.page.goto(base + '/insights/goals');
  await expect(ben.page.locator('#goal-readonly')).toBeVisible();
  const xsrf =
    (await ben.context.cookies()).find((cookie) => cookie.name === 'XSRF-TOKEN')
      ?.value ?? '';
  const asMember = await ben.page.request.post(base + '/insights/goals', {
    headers: { origin: base, 'x-xsrf-token': xsrf, 'x-inertia': 'true' },
    data: { title: 'Forged goal', target: 50 },
  });
  expect(asMember.status()).toBe(403);
  const ada = await signIn(browser, 'ada@harbor.test');
  await ada.page.goto(base + '/insights/goals');
  const noXsrf = await ada.page.request.post(base + '/insights/goals', {
    headers: { origin: base, 'x-inertia': 'true' },
    data: { title: 'No token goal', target: 50 },
  });
  expect(noXsrf.status()).toBe(403);
  for (const session of [ben, cleo, ada]) await session.context.close();
});

test('an admin pages through the board, completes a task optimistically and deletes it only after confirming', async ({
  browser,
  browserName,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const page = ada.page;
  await page.goto(base + '/app/tasks');
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  // Seven or more Harbor tasks at five per page: at least two pages.
  await expect(page.locator('#task-summary')).toContainText('page 1 of');
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('#task-summary')).toContainText('page 2 of');
  await expect(page.getByRole('link', { name: 'Page 2' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: 'Previous page' }).click();
  await expect(page.locator('#task-summary')).toContainText('page 1 of');

  const title = `Optimistic ${browserName} ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('#task-notice')).toHaveText(`Created “${title}”.`);
  await page.getByLabel('Search title or assignee').fill(title);
  await expect(page.locator('#task-list article')).toHaveCount(1);
  const row = page.locator('#task-list article');
  const done = row.locator('output[id^="task-done-"]');
  await expect(done).toHaveText('false');

  // Hold the toggle request: the projected value shows before the server answers.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/_nestvexa/live/task-row/toggleDone', async (route) => {
    await held;
    await route.continue();
  });
  const answered = page.waitForResponse((response) =>
    response.url().endsWith('/_nestvexa/live/task-row/toggleDone'),
  );
  await row.getByRole('button', { name: `Toggle done for ${title}` }).click();
  await expect(done).toHaveText('true');
  release();
  expect((await answered).ok()).toBe(true);
  await expect(done).toHaveText('true');
  await page.unroute('**/_nestvexa/live/task-row/toggleDone');

  // Dismissing the confirmation sends nothing; accepting deletes.
  page.once('dialog', (prompt) => void prompt.dismiss());
  await row.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(page.locator('#task-list article')).toHaveCount(1);
  page.once('dialog', (prompt) => {
    expect(prompt.message()).toBe(`Delete “${title}”?`);
    void prompt.accept();
  });
  await row.getByRole('button', { name: `Delete ${title}` }).click();
  await expect(page.locator('#task-notice')).toHaveText('Task deleted.');
  await expect(page.locator('#task-empty')).toHaveText(
    'No tasks match these filters.',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  const listed = (await (
    await page.request.get(base + '/api/tasks')
  ).json()) as {
    tasks: { title: string }[];
  };
  expect(listed.tasks.map((task) => task.title)).not.toContain(title);
  await axe(page);
  expect(ada.errors).toEqual([]);
  await ada.context.close();
});

/** One account per browser project, so parallel runs never share a draft. */
const wizardUser: Record<string, string> = {
  chromium: 'cleo@summit.test',
  firefox: 'dev@summit.test',
  webkit: 'ada@harbor.test',
};

test('the profile wizard validates each step, autosaves a consented draft and sends a confirmation email', async ({
  browser,
  browserName,
}) => {
  const email = wizardUser[browserName] ?? 'cleo@summit.test';
  const user = await signIn(browser, email);
  const page = user.page;
  await page.goto(base + '/app/profile');
  const wizard = page.locator('[data-nv-name="profile-wizard"]');
  await expect(wizard.locator('#profile-step-heading')).toHaveText(
    'Step 1 of 3: About you',
  );
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));

  // Server validation of step 1.
  await page.getByLabel('Display name').fill('');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(wizard.locator('#profile-summary')).toContainText(
    'Enter a display name of at least 2 characters.',
  );
  await expect(page.getByLabel('Display name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await axe(page);

  // Consent to drafts, type, and the draft survives a reload.
  const name = `Wizard ${browserName} ${Date.now().toString(36)}`;
  await page
    .getByLabel('Save drafts of this form to my account while I type')
    .check();
  await expect(wizard.locator('#draft-status')).toContainText('Draft saved');
  await page.getByLabel('Display name').fill(name);
  await expect(wizard.locator('#draft-status')).toContainText(
    /Draft saved \(version [2-9]/,
  );
  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue(name);
  await expect(wizard.locator('#draft-status')).toContainText(
    'Restored your saved draft',
  );
  await expect(
    page.getByLabel('Save drafts of this form to my account while I type'),
  ).toBeChecked();
  // The reload started a new document; every later step must keep this one.
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));

  // Step 2, back, forward again: the values stay.
  await page.getByLabel('Job title (optional)').fill('Researcher');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(wizard.locator('#profile-step-heading')).toHaveText(
    'Step 2 of 3: Preferences',
  );
  await page.getByLabel('Time zone').selectOption('Asia/Tokyo');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Display name')).toHaveValue(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Tokyo');
  await page.getByLabel('Email notifications').selectOption('daily');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: review and photo upload, then save.
  await expect(wizard.locator('#profile-step-heading')).toHaveText(
    'Step 3 of 3: Photo',
  );
  await expect(wizard.locator('#profile-review')).toContainText(name);
  await expect(wizard.locator('#profile-review')).toContainText('Asia/Tokyo');
  await page.getByLabel(/Photo \(PNG or JPEG/).setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(wizard.locator('#profile-avatar-status')).toContainText(
    // The client reports "Uploading n%" first; wait for the finished upload.
    'Uploaded 1 file',
  );
  await axe(page);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(wizard.locator('#profile-complete')).toContainText(
    'Your profile is saved.',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  // The draft was discarded on success.
  await page.reload();
  await expect(wizard.locator('#draft-status')).not.toContainText('Restored');
  await expect(page.getByLabel('Display name')).toHaveValue(name);
  // Owner-only photo.
  const avatar = await page.request.get(base + '/app/profile/avatar');
  expect(avatar.status()).toBe(200);
  expect(avatar.headers()['content-type']).toContain('image/png');
  await page.goto(base + '/app/outbox');
  await expect(
    page.locator('.mail').first().locator('.mail-subject'),
  ).toHaveText('Your Nestvexa Showcase profile is ready');
  await expect(
    page.locator('.mail').first().locator('.mail-text'),
  ).toContainText(`Hello ${name}`);
  expect(user.errors).toEqual([]);
  await user.context.close();
});

test('the profile wizard works without JavaScript through ordinary form posts', async ({
  browser,
}) => {
  const ben = await signIn(browser, 'ben@harbor.test', {
    javaScriptEnabled: false,
  });
  const page = ben.page;
  await page.goto(base + '/app/profile');
  await expect(page.locator('#profile-step-heading')).toHaveText(
    'Step 1 of 3: About you',
  );
  await page.getByLabel('Display name').fill('B');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(base + '/app/profile');
  await expect(page.locator('#profile-summary')).toContainText(
    'at least 2 characters',
  );
  await expect(page.getByLabel('Display name')).toHaveValue('B');
  await page.getByLabel('Display name').fill('Ben Ortiz');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#profile-step-heading')).toHaveText(
    'Step 2 of 3: Preferences',
  );
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('#profile-step-heading')).toHaveText(
    'Step 1 of 3: About you',
  );
  await expect(page.getByLabel('Display name')).toHaveValue('Ben Ortiz');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Time zone').selectOption('Europe/Berlin');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#profile-step-heading')).toHaveText(
    'Step 3 of 3: Photo',
  );
  await expect(page.locator('#profile-review')).toContainText('Europe/Berlin');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.flash')).toContainText('Profile saved.');
  await expect(page.locator('#profile-step-heading')).toHaveText(
    'Step 1 of 3: About you',
  );
  // No axe check here: axe runs as page script, which this context disables.
  // The same wizard markup is checked with JavaScript on in the test above.
  // A cross-site form post is refused before anything is read.
  const csrf =
    (await page.locator('input[name="_csrf"]').first().getAttribute('value')) ??
    '';
  const crossSite = await page.request.post(base + '/app/profile', {
    headers: { origin: 'https://attacker.example' },
    form: { _csrf: csrf, intent: 'next', displayName: 'Evil' },
    maxRedirects: 0,
  });
  expect(crossSite.status()).toBe(403);
  await ben.context.close();
});

test('the Vue Inertia analytics section renders on the server, defers the chart and reloads partially', async ({
  browser,
}) => {
  const ada = await signIn(browser, 'ada@harbor.test');
  const page = ada.page;
  // Server-rendered HTML contains the page before any JavaScript runs.
  const raw = await (await page.request.get(base + '/insights')).text();
  expect(raw).toContain('Harbor Studio analytics');
  expect(raw).toContain('data-server-rendered="true"');
  expect(raw).toContain('"deferredProps":{"default":["throughput"]}');
  expect(raw).not.toContain('"breakdown"');

  await page.goto(base + '/insights');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'vue');
  await expect(page.locator('#analytics-chart-table tbody tr')).toHaveCount(8);
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  const partial = page.waitForRequest(
    (request) => request.headers()['x-inertia-partial-data'] === 'breakdown',
  );
  await page.getByRole('button', { name: 'Load breakdown' }).click();
  await partial;
  await expect(page.locator('#breakdown-list')).toContainText('Ada Park:');
  await expect(page.locator('#breakdown-list')).toContainText('Ben Ortiz:');
  await axe(page);

  // Inertia navigation keeps the document; validation errors, then a flash.
  await page.getByRole('link', { name: 'Goals' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Goals');
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  await page.getByLabel('Title').fill('x');
  await page.getByLabel('Target (%)').fill('500');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.locator('#goal-title-error')).toHaveText(
    'Use a goal title of 3 to 80 characters.',
  );
  await expect(page.locator('#goal-target-error')).toContainText(
    'from 1 to 100',
  );
  await axe(page);
  const goal = `Ship ${Date.now().toString(36)}`;
  await page.getByLabel('Title').fill(goal);
  await page.getByLabel('Target (%)').fill('80');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByTestId('flash')).toHaveText(`Goal “${goal}” added.`);
  await expect(page.locator('#goal-list')).toContainText(goal);
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameDocument'))).toBe(
    true,
  );
  expect(ada.errors).toEqual([]);
  await ada.context.close();
});

test('offline and network-failure states are announced', async ({
  browser,
}) => {
  const dev = await signIn(browser, 'dev@summit.test');
  await openDashboard(dev.page);
  await expect(dev.page.locator('#metrics-offline')).toBeHidden();
  await dev.context.setOffline(true);
  await expect(dev.page.locator('#metrics-offline')).toBeVisible();
  await expect(dev.page.locator('#metrics-offline')).toHaveAttribute(
    'role',
    'status',
  );
  await dev.context.setOffline(false);
  await expect(dev.page.locator('#metrics-offline')).toBeHidden();
  await dev.context.close();
});
