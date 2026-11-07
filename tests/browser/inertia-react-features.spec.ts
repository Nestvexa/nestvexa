import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import {
  exampleUrl,
  hydrated,
  inertiaRequests,
  markDocument,
  observe,
  sameDocument,
} from './inertia-framework-suite.js';
import {
  defineScrollAndProgress,
  defineTypedActionsSuite,
  gate,
} from './inertia-feature-tour.js';

// Client-owned Inertia v3 features driven by the official @inertiajs/react
// 3.10.0 client against @nestvexa/inertia (examples/inertia-react, Vite
// production build + SSR). Each test asserts both the wire traffic the client
// produced and the resulting UI.
const base = exampleUrl('REACT', 3106);
const wait = expect.configure({ timeout: 15000 });

function path(request: Request): string {
  const url = new URL(request.url());
  return url.pathname + url.search;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(`${base}${url}`);
  await hydrated(page);
}

test.describe('Inertia React client features (official client)', () => {
  test.describe.configure({ timeout: 90000 });

  test('prefetches on hover and serves the click from the prefetch cache', async ({
    page,
  }) => {
    await open(page, '/features');
    const requests = inertiaRequests(page);
    const link = page.getByRole('link', { name: 'Prefetched page' });
    const prefetched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/features/prefetched' &&
        /prefetch/.test(response.request().headers()['purpose'] ?? ''),
    );
    await link.hover();
    const response = await prefetched;
    const body = (await response.json()) as { props: { renders: number } };
    await markDocument(page);
    await link.click();
    await wait(page.getByTestId('renders')).toHaveText(
      `Server renders: ${body.props.renders}`,
    );
    await expect(page).toHaveURL(`${base}/features/prefetched`);
    // Exactly one request reached the server: the prefetch itself.
    expect(
      requests.filter(
        (request) => new URL(request.url()).pathname === '/features/prefetched',
      ),
    ).toHaveLength(1);
    expect(await sameDocument(page)).toBe(true);
  });

  test('instant visits render the target component before the server answers', async ({
    page,
  }) => {
    await open(page, '/features');
    await markDocument(page);
    const held = await gate(page, '**/features/slow', 'GET');
    await page.getByRole('link', { name: 'Instant visit' }).click();
    await held.held;
    // The request is still parked, yet the component and URL already switched.
    await wait(page.getByRole('heading', { name: 'Slow page' })).toBeVisible();
    await expect(page).toHaveURL(`${base}/features/slow`);
    await expect(page.getByTestId('loaded')).toHaveText(
      'Waiting for the server…',
    );
    // Shared props are carried over to the intermediate page.
    await expect(page.getByTestId('app-name')).toContainText(
      'Nestvexa Inertia',
    );
    held.release();
    await wait(page.getByTestId('loaded')).toHaveText('Loaded from the server');
    expect(await sameDocument(page)).toBe(true);
  });

  test('manual visits and non-GET links use the requested methods', async ({
    page,
  }) => {
    await open(page, '/features');
    await markDocument(page);
    const requests = inertiaRequests(page);
    await page.getByRole('button', { name: 'Visit with router.visit' }).click();
    await wait(page.getByTestId('from')).toHaveText('Reached via router.visit');
    await expect(page).toHaveURL(`${base}/features/target?from=router.visit`);
    await page.getByRole('link', { name: 'Back to features' }).click();
    await page.getByRole('button', { name: 'Post with router.post' }).click();
    await wait(page.getByTestId('flash')).toHaveText('Ping via router.post');
    await page.getByRole('button', { name: 'Post with a link' }).click();
    await wait(page.getByTestId('flash')).toHaveText('Ping via link.post');
    const posts = requests.filter((request) => request.method() === 'POST');
    expect(posts.map(path)).toEqual(['/features/ping', '/features/ping']);
    expect(posts.map((request) => request.postDataJSON())).toEqual([
      { source: 'router.post' },
      { source: 'link.post' },
    ]);
    for (const post of posts)
      expect(post.headers()['x-xsrf-token']).toBeTruthy();
    expect(await sameDocument(page)).toBe(true);
  });

  test('view-transition links go through document.startViewTransition when available', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const target = window as unknown as { __transitions: number };
      target.__transitions = 0;
      const original = document.startViewTransition?.bind(document);
      if (original)
        document.startViewTransition = ((
          ...args: Parameters<typeof original>
        ) => {
          target.__transitions += 1;
          return original(...args);
        }) as typeof document.startViewTransition;
    });
    await open(page, '/features');
    const supported = await page.evaluate(
      () => typeof document.startViewTransition === 'function',
    );
    await page.getByRole('link', { name: 'View transition' }).click();
    await wait(page.getByTestId('from')).toHaveText('Reached via transition');
    const transitions = await page.evaluate(
      () => (window as unknown as { __transitions: number }).__transitions,
    );
    // Browsers without the API navigate normally (client-owned fallback).
    expect(transitions).toBe(supported ? 1 : 0);
  });

  test('polls with partial reloads and stops on request', async ({ page }) => {
    await open(page, '/features/poll');
    const requests = inertiaRequests(page);
    const first = Number(
      (await page.getByTestId('tick').textContent())?.replace('Tick ', ''),
    );
    // Polls keep running while this waits, so compare numerically.
    await expect
      .poll(
        async () =>
          Number(
            (await page.getByTestId('tick').textContent())?.replace(
              'Tick ',
              '',
            ),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(first + 2);
    const polls = requests.filter(
      (request) => new URL(request.url()).pathname === '/features/poll',
    );
    expect(polls.length).toBeGreaterThanOrEqual(2);
    for (const poll of polls) {
      expect(poll.headers()['x-inertia-partial-data']).toBe('tick');
      expect(poll.headers()['x-inertia-partial-component']).toBe(
        'Features/Poll',
      );
    }
    await page.getByRole('button', { name: 'Stop polling' }).click();
    await wait(page.getByTestId('polling')).toHaveText('Stopped');
    const stopped = requests.length;
    await page.waitForTimeout(1500);
    expect(requests.length).toBe(stopped);
  });

  test('infinite scroll appends server pages and merge props accumulate', async ({
    page,
  }) => {
    await open(page, '/features/scroll');
    const requests = inertiaRequests(page);
    const items = page.getByTestId('items').getByRole('listitem');
    await expect(items).toHaveCount(15);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await items.count()) === 45) break;
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(250);
    }
    await wait(items).toHaveCount(45);
    const labels = await items.allTextContents();
    expect(new Set(labels).size).toBe(45);
    expect(labels[0]).toBe('Item 1');
    expect(labels[44]).toBe('Item 45');
    const pages = requests.filter(
      (request) => request.headers()['x-inertia-partial-data'] === 'items',
    );
    expect(
      pages.map((request) => new URL(request.url()).searchParams.get('page')),
    ).toEqual(['2', '3']);
    for (const request of pages)
      expect(
        request.headers()['x-inertia-infinite-scroll-merge-intent'] ?? 'append',
      ).toBe('append');
    // A merge prop keeps earlier entries across partial reloads.
    await page.getByRole('button', { name: 'Load more notes' }).click();
    await wait(page.getByTestId('notes').getByRole('listitem')).toHaveText([
      'Note batch 1',
      'Note batch 2',
    ]);
    await expect(items).toHaveCount(45);
  });

  test('WhenVisible loads an optional prop only once it scrolls into view', async ({
    page,
  }) => {
    await open(page, '/features/lazy');
    const requests = inertiaRequests(page);
    await expect(page.getByTestId('below')).toHaveText('Not loaded yet');
    await page.waitForTimeout(800);
    expect(requests).toHaveLength(0);
    const loaded = page.waitForResponse(
      (response) =>
        response.request().headers()['x-inertia-partial-data'] === 'below',
    );
    await page.getByTestId('below').scrollIntoViewIfNeeded();
    const body = (await (await loaded).json()) as {
      props: Record<string, unknown>;
    };
    expect(Object.keys(body.props).sort()).toEqual(['below', 'errors']);
    await wait(page.getByTestId('below')).toHaveText('Loaded when visible');
  });

  test('remembered state survives navigating away and back', async ({
    page,
  }) => {
    await open(page, '/features/remember');
    await page.getByLabel('Draft note').fill('half-written thought');
    await page.getByLabel('Form topic').fill('Inertia remember');
    await page.getByRole('link', { name: 'Back to features' }).click();
    await wait(
      page.getByRole('heading', { name: 'Client features' }),
    ).toBeVisible();
    await page.goBack();
    await wait(page.getByLabel('Draft note')).toHaveValue(
      'half-written thought',
    );
    await expect(page.getByLabel('Form topic')).toHaveValue('Inertia remember');
  });

  test('once props are resolved once and reused on the next page', async ({
    page,
  }) => {
    await open(page, '/features/once/a');
    const token = await page.getByTestId('plans-token').textContent();
    expect(token).toMatch(/^Plans token [0-9a-f]{12}$/);
    const visit = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/features/once/b',
    );
    await page.getByRole('link', { name: 'Go to step b' }).click();
    const response = await visit;
    expect(response.request().headers()['x-inertia-except-once-props']).toBe(
      'plans',
    );
    const body = (await response.json()) as {
      props: Record<string, unknown>;
      onceProps?: Record<string, unknown>;
    };
    expect(body.props['plans']).toBeUndefined();
    await wait(
      page.getByRole('heading', { name: 'Once props: step b' }),
    ).toBeVisible();
    await expect(page.getByTestId('plans-token')).toHaveText(token ?? '');
  });

  test('history encryption keeps props out of history.state and clearHistory forces a refetch', async ({
    page,
  }) => {
    await open(page, '/features');
    await markDocument(page);
    await page.getByRole('link', { name: 'Encrypted history' }).click();
    const secret = await wait(page.getByTestId('secret'))
      .toHaveText(/^classified-[0-9a-f]{12}$/)
      .then(() => page.getByTestId('secret').textContent());
    const state = await page.evaluate(() => {
      const entry = (window.history.state ?? {}) as { page?: unknown };
      return {
        encrypted: entry.page instanceof ArrayBuffer,
        key: window.sessionStorage.getItem('historyKey') !== null,
        text: JSON.stringify(entry),
      };
    });
    expect(state).toMatchObject({ encrypted: true, key: true });
    expect(state.text).not.toContain('classified-');
    // Going back and forward decrypts the entry locally: no new request.
    const requests = inertiaRequests(page);
    await page.getByRole('link', { name: 'Back to features' }).click();
    await wait(
      page.getByRole('heading', { name: 'Client features' }),
    ).toBeVisible();
    await page.goBack();
    await wait(page.getByTestId('secret')).toHaveText(secret ?? '');
    expect(
      requests.filter(
        (request) => new URL(request.url()).pathname === '/features/secret',
      ),
    ).toHaveLength(0);
    // The server's clearHistory flag makes the client drop its keys...
    const cleared = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/features' &&
        response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Forget history' }).click();
    const clearPage = (await (await cleared).json()) as {
      clearHistory?: boolean;
    };
    expect(clearPage.clearHistory).toBe(true);
    await wait(
      page.getByRole('heading', { name: 'Client features' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.sessionStorage.getItem('historyKey')),
    ).toBeNull();
    // ...so the old encrypted entry can no longer be decrypted and is refetched.
    const refetch = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/features/secret' &&
        request.headers()['x-inertia'] === 'true',
    );
    await page.goBack();
    await refetch;
    await wait(page.getByTestId('secret')).toHaveText(/^classified-/);
    expect(await page.getByTestId('secret').textContent()).not.toBe(secret);
    expect(await sameDocument(page)).toBe(true);
  });

  test('optimistic updates show immediately and roll back when the server rejects them', async ({
    page,
    browserName,
  }) => {
    await open(page, '/features/todos');
    const title = `Buy milk ${browserName} ${Date.now()}`;
    let held = await gate(page, '**/features/todos', 'POST');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Add todo' }).click();
    await held.held;
    const todos = page.getByTestId('todos').getByRole('listitem');
    // Visible while the POST is still parked in the browser.
    await wait(todos.filter({ hasText: title })).toHaveAttribute(
      'data-pending',
      'true',
    );
    held.release();
    await wait(todos.filter({ hasText: title })).toHaveAttribute(
      'data-pending',
      'false',
    );
    await expect(todos.filter({ hasText: title })).toHaveCount(1);
    await page.unrouteAll();
    held = await gate(page, '**/features/todos', 'POST');
    const before = await todos.count();
    await page.getByLabel('Title').fill('fail');
    await page.getByRole('button', { name: 'Add todo' }).click();
    await held.held;
    await wait(todos.filter({ hasText: 'fail' })).toHaveCount(1);
    held.release();
    await wait(page.locator('#title-error')).toHaveText(
      'The server rejected this todo.',
    );
    await expect(todos.filter({ hasText: 'fail' })).toHaveCount(0);
    await expect(todos).toHaveCount(before);
  });

  test('Precognition validates touched fields without submitting, then the form submits', async ({
    page,
  }) => {
    const observed = await observe(page);
    await open(page, '/features/signup');
    await markDocument(page);
    const validation = (field: string) =>
      page.waitForResponse(
        (response) =>
          response.request().headers()['precognition'] === 'true' &&
          (response.request().headers()['precognition-validate-only'] ?? '')
            .split(',')
            .includes(field),
      );
    let reply = validation('name');
    await page.getByLabel('Name').fill('taken');
    await page.getByLabel('Name').blur();
    let response = await reply;
    expect(response.status()).toBe(422);
    expect(response.headers()['precognition']).toBe('true');
    expect(response.request().headers()['x-xsrf-token']).toBeTruthy();
    await wait(page.locator('#signup-name-error')).toHaveText(
      'The name has already been taken.',
    );
    await expect(page.getByLabel('Name')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    reply = validation('name');
    await page.getByLabel('Name').fill('Ada');
    await page.getByLabel('Name').blur();
    response = await reply;
    expect(response.status()).toBe(204);
    expect(response.headers()['precognition-success']).toBe('true');
    await wait(page.getByTestId('signup-name-valid')).toBeVisible();
    await expect(page.locator('#signup-name-error')).toHaveCount(0);
    reply = validation('email');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Email').blur();
    response = await reply;
    expect(response.status()).toBe(422);
    await wait(page.locator('#signup-email-error')).toHaveText(
      'The email must be a valid email address.',
    );
    // Validation-only requests never ran the handler: nothing was flashed.
    await expect(page.getByTestId('flash')).toHaveCount(0);
    await page.getByLabel('Email').fill('ada@example.test');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await wait(page.getByTestId('flash')).toHaveText('Welcome, Ada');
    await expect(page).toHaveURL(`${base}/features`);
    expect(await sameDocument(page)).toBe(true);
    expect(observed.errors).toEqual([]);
  });

  test('large page payloads load fully on first visit and over XHR', async ({
    page,
    request,
  }) => {
    const document = await request.get(`${base}/features/large`);
    expect(document.status()).toBe(200);
    const html = await document.text();
    expect(html.length).toBeGreaterThan(1_500_000);
    // The embedded page object survives intact: a raw `</script>` inside the
    // JSON would end the element early and break parsing.
    const embedded =
      /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1];
    const parsed = JSON.parse(embedded ?? 'null') as {
      props: { rows: { note: string }[] };
    };
    expect(parsed.props.rows).toHaveLength(20000);
    expect(parsed.props.rows[19999]?.note).toBe(
      'Large payload <script>not markup</script> & text',
    );
    await open(page, '/features/large');
    await wait(page.getByTestId('row-count')).toHaveText('Rows: 20000');
    await expect(page.getByTestId('row-checksum')).toHaveText(
      'Checksum: 200010000',
    );
    await page.goto(`${base}/features`);
    await hydrated(page);
    await markDocument(page);
    const xhr = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/features/large',
    );
    await page.getByRole('link', { name: 'Large payload' }).click();
    const response = await xhr;
    expect((await response.body()).length).toBeGreaterThan(1_500_000);
    await wait(page.getByTestId('row-count')).toHaveText('Rows: 20000');
    await expect(page.getByTestId('row-last')).toHaveText(
      'Row 20000 · row20000@example.test',
    );
    await expect(page.getByTestId('row-note')).toHaveText(
      'Large payload <script>not markup</script> & text',
    );
    expect(await sameDocument(page)).toBe(true);
  });
});

defineScrollAndProgress({ framework: 'React', base, home: '/features' });
defineTypedActionsSuite({ framework: 'React', base });
