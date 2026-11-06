import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/** The auth-forms example; overridable so the spec can run on another port. */
const base = process.env['NV_AUTH_FORMS_URL'] ?? 'http://127.0.0.1:3104';
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
async function register(page: Page, name: string, address: string) {
  await page.goto(base + '/register');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/profile');
}
/**
 * Browser autofill writes values without key events. Chromium, Firefox and
 * WebKit dispatch `input` and `change` for autofilled controls; `events: false`
 * models a password manager that sets values silently (only native form
 * submission can observe those).
 */
async function autofill(
  page: Page,
  values: Readonly<Record<string, string>>,
  events = true,
): Promise<void> {
  await page.evaluate(
    ({ values, events }) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      const areaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      for (const [id, value] of Object.entries(values)) {
        const element = document.getElementById(id);
        if (element instanceof HTMLInputElement) setter?.call(element, value);
        else if (element instanceof HTMLTextAreaElement)
          areaSetter?.call(element, value);
        else throw new Error(`No control ${id}`);
        if (events) {
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    },
    { values, events },
  );
}

test('form controls carry autocomplete tokens for password managers and autofill', async ({
  page,
}) => {
  await page.goto(base + '/register');
  await expect(page.getByLabel('Display name')).toHaveAttribute(
    'autocomplete',
    'name',
  );
  await expect(page.getByLabel('Email')).toHaveAttribute(
    'autocomplete',
    'email',
  );
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'new-password',
  );
  await page.goto(base + '/login');
  await expect(page.getByLabel('Email')).toHaveAttribute(
    'autocomplete',
    'username',
  );
  await expect(page.getByLabel('Password')).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
});

test('silently autofilled no-JS registration submits every value', async ({
  page,
}, info) => {
  await page.goto(base + '/register');
  await autofill(
    page,
    {
      'register-displayName': 'Autofill Ada',
      'register-email': email(info, 'autofill'),
      'register-password': password,
      'register-passwordConfirmation': password,
    },
    false,
  );
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#flash')).toContainText('Welcome, Autofill Ada');
});

test('autofilled Live profile fields are sent with the submit even when never focused or blurred', async ({
  page,
}, info) => {
  const errors = watch(page);
  await register(page, 'Before', email(info, 'live-autofill'));
  const address = email(info, 'live-autofill-new');
  let saves = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/_nestvexa/live/profile-editor/save')) saves++;
  });
  // Fields use nv:model.blur; autofill fires input/change but no blur.
  await autofill(page, {
    'profile-displayName': 'After Autofill',
    'profile-email': address,
    'profile-bio': 'Filled by the browser.',
  });
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');
  expect(saves).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue('After Autofill');
  await expect(page.getByLabel('Email')).toHaveValue(address);
  await expect(page.getByLabel('Bio')).toHaveValue('Filled by the browser.');
  expect(errors).toEqual([]);
});

test('Back after a successful no-JS registration shows a fresh form and never resubmits', async ({
  page,
}, info) => {
  const errors = watch(page);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST')
      posts.push(new URL(request.url()).pathname);
  });
  await register(page, 'History', email(info, 'history'));
  expect(posts).toEqual(['/register']);
  await page.goBack();
  await expect(page).toHaveURL(base + '/register');
  await expect(
    page.getByRole('button', { name: 'Create account' }),
  ).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.locator('#register-summary')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.getByLabel('Display name')).toHaveValue('History');
  // The welcome flash is read once and does not come back with history.
  await expect(page.getByText('Welcome, History')).toHaveCount(0);
  expect(posts).toEqual(['/register']);
  expect(errors).toEqual([]);
});

test('Back to a failed registration keeps the form submittable with fresh tokens', async ({
  page,
}, info) => {
  await page.goto(base + '/register');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#register-summary')).toBeVisible();
  await page.goto(base + '/login');
  await page.goBack();
  await expect(page).toHaveURL(base + '/register');
  await page.getByLabel('Display name').fill('Back Again');
  await page.getByLabel('Email').fill(email(info, 'back-again'));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(base + '/profile');
  await expect(page.locator('#flash')).toContainText('Welcome, Back Again');
});

test('the Live profile editor still validates and saves after Back and Forward', async ({
  page,
}, info) => {
  const errors = watch(page);
  await register(page, 'Roundtrip', email(info, 'roundtrip'));
  await page.getByLabel('Bio').fill('Typed before leaving.');
  await page.goto(base + '/');
  await page.goBack();
  await expect(page).toHaveURL(base + '/profile');
  const name = page.getByLabel('Display name');
  await name.fill('R');
  await page.getByLabel('Bio').focus();
  await expect(page.locator('#profile-displayName-error')).toHaveText(
    'Enter a name between 2 and 60 characters.',
  );
  await name.fill('Roundtrip Two');
  // Let the blur sync clear the error first: removing it shifts the button,
  // which would otherwise move it between mousedown and mouseup in WebKit.
  await page.getByLabel('Bio').focus();
  await expect(page.locator('#profile-displayName-error')).toHaveText('');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');
  await page.goto(base + '/');
  await page.goBack();
  await page.goForward();
  await page.goBack();
  await expect(page.getByLabel('Display name')).toHaveValue('Roundtrip Two');
  expect(errors).toEqual([]);
});
