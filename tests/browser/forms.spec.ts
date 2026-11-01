import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

const base = 'http://127.0.0.1:3104';
// Multi-page journeys with scrypt hashing and axe scans across three engines.
test.describe.configure({ timeout: 120_000 });
const password = 'correct horse battery staple';

function email(info: TestInfo, label: string): string {
  return `${label}-${info.project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}
async function axe(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function register(page: Page, name: string, address: string) {
  await page.goto(base + '/register');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#flash')).toContainText(`Welcome, ${name}`);
}
async function sessionCookie(context: BrowserContext): Promise<string> {
  return (
    (await context.cookies(base)).find(
      (cookie) => cookie.name === 'nvforms.sid',
    )?.value ?? ''
  );
}
async function signedInContext(
  browser: Browser,
  info: TestInfo,
  label: string,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const address = email(info, label);
  await register(page, label, address);
  return { context, page, address };
}

test('registration validates on the server, then signs in with a regenerated session (accessibility)', async ({
  page,
  context,
}, info) => {
  const errors = watch(page);
  await page.goto(base + '/register');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/register');
  const summary = page.locator('#register-summary');
  // Empty password and confirmation match, so three fields are reported.
  await expect(summary).toContainText('There are 3 problems');
  await expect(page.getByLabel('Display name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByLabel('Display name')).toHaveAttribute(
    'aria-describedby',
    'register-displayName-error',
  );
  await axe(page);

  const address = email(info, 'ada');
  await page.getByLabel('Display name').fill('Ada');
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill('a different password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#register-passwordConfirmation-error')).toHaveText(
    'Passwords do not match.',
  );
  // Old input survives the redirect; passwords never do.
  await expect(page.getByLabel('Email')).toHaveValue(address);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

  const anonymous = await sessionCookie(context);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#flash')).toContainText('Welcome, Ada');
  expect(await sessionCookie(context)).not.toBe(anonymous);
  await axe(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(base + '/login');
  await expect(page.locator('#flash')).toHaveText('You have signed out.');
  await page.goto(base + '/profile');
  await expect(
    page.getByRole('link', { name: 'Sign in' }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('failed sign-in is generic; success regenerates the session (accessibility)', async ({
  page,
  context,
  browser,
}, info) => {
  const errors = watch(page);
  const account = await signedInContext(browser, info, 'grace');
  await account.context.close();

  await page.goto(base + '/login');
  await page.getByLabel('Email').fill(account.address);
  await page.getByLabel('Password').fill('wrong password, sorry');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-summary')).toContainText(
    'The email or password is incorrect.',
  );
  await expect(page.getByLabel('Email')).toHaveValue(account.address);
  await expect(page.getByLabel('Password')).toHaveValue('');
  await axe(page);

  // An unknown account produces exactly the same message.
  await page.getByLabel('Email').fill(email(info, 'nobody'));
  await page.getByLabel('Password').fill('wrong password, sorry');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-summary li')).toHaveText(
    'The email or password is incorrect.',
  );

  const before = await sessionCookie(context);
  await page.getByLabel('Email').fill(account.address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#flash')).toHaveText('You are signed in.');
  expect(await sessionCookie(context)).not.toBe(before);
  await expect(page.getByLabel('Display name')).toHaveValue('grace');

  expect(errors).toEqual([]);
});

test('five failed sign-ins lock the account, even for the right password', async ({
  page,
  browser,
}, info) => {
  const errors = watch(page);
  const account = await signedInContext(browser, info, 'locked');
  await account.context.close();
  await page.goto(base + '/login');
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByLabel('Email').fill(account.address);
    await page.getByLabel('Password').fill(`wrong password ${attempt}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The re-rendered page never keeps the password.
    await expect(page.getByLabel('Password')).toHaveValue('');
    await expect(page.locator('#login-summary')).toBeVisible();
  }
  await page.getByLabel('Email').fill(account.address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-summary')).toContainText(
    'Too many sign-in attempts',
  );
  await expect(page).toHaveURL(base + '/login');
  expect(errors).toEqual([]);
});

test('Live profile validates fields on blur, focuses the first invalid field on submit and saves (accessibility)', async ({
  browser,
}, info) => {
  const other = await signedInContext(browser, info, 'other');
  await other.context.close();
  const { context, page } = await signedInContext(browser, info, 'lin');
  const errors = watch(page);
  const name = page.getByLabel('Display name');
  const address = page.getByLabel('Email');

  // Live per-field validation after blur: the error appears, focus stays put.
  await name.fill('L');
  await address.focus();
  await expect(page.locator('#profile-displayName-error')).toHaveText(
    'Enter a name between 2 and 60 characters.',
  );
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAttribute(
    'aria-describedby',
    'profile-displayName-error',
  );
  await expect(address).toBeFocused();

  // Async uniqueness check through the same Live synchronization.
  await address.fill(other.address);
  await page.getByLabel('Bio').focus();
  await expect(page.locator('#profile-email-error')).toHaveText(
    'Another account already uses this email address.',
  );

  // Submit: every field is validated, a summary links to fields, and focus
  // moves to the first invalid control.
  await page.getByLabel('Bio').fill('Accessible forms, server validated.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#profile-summary')).toContainText(
    'There are 2 problems',
  );
  await expect(name).toBeFocused();
  await expect(
    page.locator('#profile-summary a[href="#profile-email"]'),
  ).toContainText('Another account already uses this email address.');
  await axe(page);

  // A user who moves focus during the request keeps it.
  await address.fill('not-an-email');
  await page.getByRole('button', { name: 'Save profile' }).focus();
  await page.evaluate(() => {
    const form = document.getElementById('profile-form');
    if (!(form instanceof HTMLFormElement)) throw new Error('form');
    form.requestSubmit();
    document.getElementById('profile-bio')?.focus();
  });
  await expect(page.locator('#profile-email-error')).toHaveText(
    'Enter a valid email address.',
  );
  await expect(page.getByLabel('Bio')).toBeFocused();

  // Fix and save; a repeated submit while one is in flight sends one request.
  let saves = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/_nestvexa/live/profile-editor/save')) saves++;
  });
  await name.fill('Lin Lovelace');
  await address.fill(email(info, 'lin-new'));
  await page.evaluate(() => {
    const form = document.getElementById('profile-form');
    if (!(form instanceof HTMLFormElement)) throw new Error('form');
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(page.locator('#profile-summary')).toHaveCount(0);
  expect(saves).toBe(1);
  await page.reload();
  await expect(name).toHaveValue('Lin Lovelace');
  await axe(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('profile editor works without JavaScript, including version conflicts (accessibility)', async ({
  browser,
}, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await register(page, 'Noor', email(info, 'noor'));
  const name = page.getByLabel('Display name');

  await name.fill('N');
  await page.getByLabel('Bio').fill('Plain HTML still works.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#profile-displayName-error')).toHaveText(
    'Enter a name between 2 and 60 characters.',
  );
  await expect(name).toHaveValue('N');
  await expect(page.getByLabel('Bio')).toHaveValue('Plain HTML still works.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#profile-summary')).toContainText(
    'There is 1 problem',
  );
  // axe needs script injection; the same markup is audited with JavaScript on.

  await name.fill('Noor Haddad');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#flash')).toHaveText('Profile saved.');
  await expect(name).toHaveValue('Noor Haddad');
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);

  // Two tabs start from the same version; the second save is refused.
  const second = await context.newPage();
  await second.goto(base + '/profile');
  await page.getByLabel('Bio').fill('Saved first.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#flash')).toHaveText('Profile saved.');
  await second.getByLabel('Bio').fill('Saved second, from a stale tab.');
  await second.getByRole('button', { name: 'Save profile' }).click();
  await expect(second.locator('#profile-summary')).toContainText(
    'changed in another tab or window',
  );
  await second.reload();
  await expect(second.getByLabel('Bio')).toHaveValue('Saved first.');
  await context.close();
});

test('repeated no-JS registration submits create one account and replay the same redirect', async ({
  page,
}, info) => {
  await page.goto(base + '/register');
  const csrf = await page.locator('input[name="_csrf"]').inputValue();
  const submission = await page
    .locator('input[name="_submission"]')
    .inputValue();
  const address = email(info, 'twice');
  const form = {
    _csrf: csrf,
    _submission: submission,
    displayName: 'Twice',
    email: address,
    password,
    passwordConfirmation: password,
  };
  const replies = await Promise.all(
    [0, 1].map(() =>
      page.request.post(base + '/register', {
        form,
        headers: { origin: base },
        maxRedirects: 0,
      }),
    ),
  );
  expect(replies.map((reply) => reply.status())).toEqual([303, 303]);
  expect(replies.map((reply) => reply.headers()['location'])).toEqual([
    '/profile',
    '/profile',
  ]);
  await page.goto(base + '/profile');
  await expect(page.getByLabel('Email')).toHaveValue(address);
  // A replay of the claimed token only repeats the redirect, even when its
  // session was regenerated by the first request.
  const replay = await page.request.post(base + '/register', {
    form: { ...form, _csrf: 'stale-token-stale-token-stale-token-0' },
    headers: { origin: base },
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(303);
  expect(replay.headers()['location']).toBe('/profile');
  // Without a claimed token, a forged CSRF token or foreign origin is refused.
  const { _submission: _unused, ...unclaimed } = form;
  expect(_unused).toBe(submission);
  const forged = await page.request.post(base + '/register', {
    form: { ...unclaimed, _csrf: 'forged-token-forged-token-forged-token-0' },
    headers: { origin: base },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  const crossSite = await page.request.post(base + '/login', {
    form: { _csrf: csrf, email: address, password },
    headers: { origin: 'https://attacker.example' },
    maxRedirects: 0,
  });
  expect(crossSite.status()).toBe(403);
});
