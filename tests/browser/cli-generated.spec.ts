import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * examples/cli-generated: an app produced only by the CLI (plus one showcase
 * page). Served with NESTVEXA_ASSETS=build so the Inertia roots render on the
 * server and hydrate from their built bundles.
 */
const origin = 'http://127.0.0.1:3126';
// First renders import SSR bundles and engines (cold module loading).
test.describe.configure({ timeout: 120_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}
async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

test('init: the Live counter increments through the generated session policy (accessibility)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(`${origin}/nestvexa`);
  await expect(
    page.getByRole('heading', { name: 'Nestvexa is ready' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Increment' }).click();
  await expect(page.locator('output')).toHaveText('1');
  await page.getByRole('button', { name: 'Increment' }).click();
  await expect(page.locator('output')).toHaveText('2');
  await axe(page);
  expect(errors).toEqual([]);
});

test('make:page renders Handlebars, EJS, Pug and Nunjucks pages through their layouts', async ({
  page,
}) => {
  for (const [path, heading, engine] of [
    ['/home', 'Home', 'Handlebars'],
    ['/report-ejs', 'ReportEjs', 'EJS'],
    ['/report-pug', 'ReportPug', 'Pug'],
    ['/report-nunjucks', 'ReportNunjucks', 'Nunjucks'],
  ] as const) {
    await page.goto(`${origin}${path}`);
    await expect(page).toHaveTitle(heading);
    await expect(
      page.getByRole('main').getByRole('heading', { name: heading }),
    ).toBeVisible();
    await expect(page.getByText(`page rendered by ${engine}`)).toBeVisible();
  }
});

for (const [path, component, title, label] of [
  ['/react-dashboard', 'ReactDashboard', 'ReactDashboard · React', 'React'],
  ['/vue-dashboard', 'VueDashboard', 'VueDashboard · Vue', 'Vue'],
  ['/svelte-dashboard', 'SvelteDashboard', 'SvelteDashboard', 'Svelte'],
] as const)
  test(`make:page --renderer ${label.toLowerCase()}: the server-rendered Inertia page hydrates (accessibility)`, async ({
    page,
    request,
  }) => {
    const errors = collectErrors(page);
    // The HTML already holds the page (SSR), before any script runs.
    const html = await (await request.get(`${origin}${path}`)).text();
    expect(html).toContain('data-server-rendered="true"');
    expect(html).toMatch(new RegExp(`<h1>${component}</h1>`));
    await page.goto(`${origin}${path}`);
    await expect(page).toHaveTitle(title);
    await expect(page.getByRole('heading', { name: component })).toBeVisible();
    await expect(
      page.getByText(`Rendered by ${label} through Inertia.`),
    ).toBeVisible();
    // The hydrated page's version answers an Inertia (JSON) visit.
    const visit = await page.evaluate(async (url) => {
      const data = document.querySelector('script[data-page]')?.textContent;
      const parsed: unknown = JSON.parse(data ?? '{}');
      const version: unknown =
        parsed && typeof parsed === 'object'
          ? Reflect.get(parsed, 'version')
          : undefined;
      const response = await fetch(url, {
        headers: {
          'X-Inertia': 'true',
          'X-Inertia-Version': typeof version === 'string' ? version : '',
        },
      });
      return { status: response.status, body: await response.text() };
    }, `${origin}${path}`);
    expect(visit.status).toBe(200);
    expect(JSON.parse(visit.body)).toMatchObject({ component });
    await axe(page);
    expect(errors).toEqual([]);
  });

test('make:form, make:resource and make:island work together on one page (accessibility)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(`${origin}/showcase`);
  await expect(
    page.getByRole('heading', { name: 'Welcome · Showcase', level: 1 }),
  ).toBeVisible();

  // Generated form: server-side Zod validation on blur and on submit.
  const form = page.getByRole('form', { name: 'Contact' });
  await form.getByLabel('Name').fill('A');
  await form.getByLabel('Email').fill('not-an-email');
  await form.getByLabel('Email').blur();
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByRole('alert').first()).toBeVisible();
  await expect(form.getByLabel('Email')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await form.getByLabel('Name').fill('Ada');
  await form.getByLabel('Email').fill('ada@example.test');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.getByRole('status')).toHaveText('Thanks, Ada.');

  // Generated Live table backed by the generated in-memory service.
  const tasks = page.getByRole('region', { name: 'Task' });
  // The in-memory service is shared by every browser project of the run.
  const task = `Write docs (${test.info().project.name})`;
  await tasks.getByLabel('Name').fill(task);
  await tasks.getByRole('button', { name: 'Add' }).click();
  await expect(
    tasks.getByRole('listitem').filter({ hasText: task }),
  ).toHaveCount(1);
  await tasks.getByLabel('Name').fill('x');
  await tasks.getByRole('button', { name: 'Add' }).click();
  await expect(tasks.getByRole('alert')).toHaveText(
    'Enter at least 2 characters.',
  );

  // Generated React island, mounted by the generated islands bundle.
  const island = page.getByRole('button', { name: /^Clicks: \d+$/ });
  await expect(island).toHaveText('Clicks: 0');
  await island.click();
  await expect(island).toHaveText('Clicks: 1');

  // The REST controller of make:resource --crud shares the service.
  const listed = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.json()) as { name: string }[];
  }, `${origin}/task`);
  expect(listed.map((item) => item.name)).toContain(task);
  await axe(page);
  expect(errors).toEqual([]);
});

test('make:action: the generated action endpoint refuses requests without a session CSRF token', async ({
  request,
}) => {
  const response = await request.post(
    `${origin}/_nestvexa/actions/greeter/greet`,
    {
      headers: { origin, 'content-type': 'application/json' },
      data: { input: { name: 'Ada' } },
    },
  );
  expect([401, 403]).toContain(response.status());
});
