import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import {
  hydrated,
  inertiaRequests,
  markDocument,
  observe,
  sameDocument,
} from './inertia-framework-suite.js';
import type { FrameworkSuite } from './inertia-framework-suite.js';

// Client-owned Inertia v3 features shared by examples/inertia-{react,vue,svelte}
// and driven by each official client: the feature tour (Vue and Svelte; React
// runs its own in inertia-react-features), scroll management plus the
// progress indicator, and typed server actions through the generated
// framework binding on an Inertia page (all three).

const wait = expect.configure({ timeout: 15000 });

function path(request: Request): string {
  const url = new URL(request.url());
  return url.pathname + url.search;
}

/** Holds matching requests until `release()`, to observe in-flight UI deterministically. */
export async function gate(
  page: Page,
  pattern: string,
  method: string,
): Promise<{ release: () => void; held: Promise<void> }> {
  let release = () => {};
  let markHeld = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  const held = new Promise<void>((resolve) => (markHeld = resolve));
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== method) return route.continue();
    markHeld();
    await open;
    await route.continue();
  });
  return { release: () => release(), held };
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await hydrated(page);
}

/**
 * Instant and manual visits, non-GET links, view transitions, remembered
 * state, once props and optimistic updates on `/features/tour`.
 */
export function defineFeatureTour({ framework, base }: FrameworkSuite): void {
  const tour = `${base}/features/tour`;

  test.describe(`Inertia ${framework} client features tour`, () => {
    test.describe.configure({ timeout: 90000 });

    test('instant visits render the target component before the server answers', async ({
      page,
    }) => {
      await open(page, tour);
      await markDocument(page);
      const held = await gate(page, '**/features/slow', 'GET');
      await page.getByRole('link', { name: 'Instant visit' }).click();
      await held.held;
      // The request is still parked, yet the component and URL already switched.
      await wait(
        page.getByRole('heading', { name: 'Slow page' }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${base}/features/slow`);
      await expect(page.getByTestId('loaded')).toHaveText(
        'Waiting for the server…',
      );
      // Shared props are carried over to the intermediate page.
      await expect(page.getByTestId('app-name')).toContainText(framework);
      held.release();
      await wait(page.getByTestId('loaded')).toHaveText(
        'Loaded from the server',
      );
      expect(await sameDocument(page)).toBe(true);
    });

    test('manual visits and non-GET links use the requested methods', async ({
      page,
    }) => {
      await open(page, tour);
      await markDocument(page);
      const requests = inertiaRequests(page);
      await page
        .getByRole('button', { name: 'Visit with router.visit' })
        .click();
      await wait(page.getByTestId('from')).toHaveText(
        'Reached via router.visit',
      );
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
      await open(page, tour);
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

    test('remembered state survives navigating away and back', async ({
      page,
    }) => {
      await open(page, `${base}/features/remember`);
      await page.getByLabel('Draft note').fill('half-written thought');
      await page.getByLabel('Form topic').fill('Inertia remember');
      await page.getByRole('link', { name: 'Back to features' }).click();
      await wait(
        page.getByRole('heading', { name: 'Client features tour' }),
      ).toBeVisible();
      await page.goBack();
      await wait(page.getByLabel('Draft note')).toHaveValue(
        'half-written thought',
      );
      await expect(page.getByLabel('Form topic')).toHaveValue(
        'Inertia remember',
      );
    });

    test('once props are resolved once and reused on the next page', async ({
      page,
    }) => {
      await open(page, `${base}/features/once/a`);
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
      };
      expect(body.props['plans']).toBeUndefined();
      await wait(
        page.getByRole('heading', { name: 'Once props: step b' }),
      ).toBeVisible();
      await expect(page.getByTestId('plans-token')).toHaveText(token ?? '');
    });

    test('optimistic updates show immediately and roll back when the server rejects them', async ({
      page,
      browserName,
    }) => {
      await open(page, `${base}/features/todos`);
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
  });
}

interface ScrollState {
  readonly window: number;
  readonly region: number;
  /** What the client stored in the current history entry. */
  readonly saved: { readonly window?: number; readonly region?: number };
}

function scrollState(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const region = document.querySelector('[scroll-region]');
    const state = (window.history.state ?? {}) as {
      documentScrollPosition?: { top?: number };
      scrollRegions?: { top?: number }[];
    };
    return {
      window: Math.round(window.scrollY),
      region: Math.round(region?.scrollTop ?? -1),
      saved: {
        ...(state.documentScrollPosition?.top === undefined
          ? {}
          : { window: Math.round(state.documentScrollPosition.top) }),
        ...(state.scrollRegions?.[0]?.top === undefined
          ? {}
          : { region: Math.round(state.scrollRegions[0].top) }),
      },
    };
  });
}

/**
 * Scrolls the window to the bottom (where the long page's links are, so
 * clicking them scrolls nothing) and the scroll region to `region`, then
 * waits until the client has saved both in the history entry.
 */
async function scrollLongPage(page: Page, region: number): Promise<number> {
  const top = await page.evaluate((offset) => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const element = document.querySelector('[scroll-region]');
    if (element) element.scrollTop = offset;
    return Math.round(window.scrollY);
  }, region);
  expect(top).toBeGreaterThan(200);
  await wait
    .poll(async () => (await scrollState(page)).saved)
    .toEqual({ window: top, region });
  return top;
}

/** Scroll reset/preserve/restore, hash anchors and the progress indicator. */
export function defineScrollAndProgress({
  framework,
  base,
  home,
}: FrameworkSuite & {
  /** Page holding the "Slow page" link and the "Quiet slow visit" button. */
  readonly home: string;
}): void {
  test.describe(`Inertia ${framework} scroll management and progress`, () => {
    test.describe.configure({ timeout: 90000 });

    test('visits reset the window and scroll regions; back restores both', async ({
      page,
    }) => {
      await open(page, `${base}/features/long/1`);
      await markDocument(page);
      const top = await scrollLongPage(page, 200);
      await page.getByRole('link', { name: 'Next long page' }).click();
      await wait(
        page.getByRole('heading', { name: 'Long page 2' }),
      ).toBeVisible();
      await wait
        .poll(async () => {
          const state = await scrollState(page);
          return [state.window, state.region];
        })
        .toEqual([0, 0]);
      await page.goBack();
      await wait(
        page.getByRole('heading', { name: 'Long page 1' }),
      ).toBeVisible();
      await wait
        .poll(async () => {
          const state = await scrollState(page);
          return [state.window, state.region];
        })
        .toEqual([top, 200]);
      expect(await sameDocument(page)).toBe(true);
    });

    test('preserveScroll keeps both positions and hash visits scroll to the anchor', async ({
      page,
    }) => {
      await open(page, `${base}/features/long/1`);
      const top = await scrollLongPage(page, 120);
      await page.getByRole('link', { name: 'Next, preserving scroll' }).click();
      await wait(
        page.getByRole('heading', { name: 'Long page 2' }),
      ).toBeVisible();
      await wait
        .poll(async () => {
          const state = await scrollState(page);
          return [state.window, state.region];
        })
        .toEqual([top, 120]);
      await page.getByRole('link', { name: 'Next, to the anchor' }).click();
      await wait(
        page.getByRole('heading', { name: 'Long page 3' }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${base}/features/long/3#anchor`);
      await wait(
        page.getByRole('heading', { name: 'Anchor on page 3' }),
      ).toBeInViewport();
      await wait.poll(async () => (await scrollState(page)).region).toBe(0);
    });

    test('shows the progress bar for slow visits unless showProgress is false', async ({
      page,
    }) => {
      await open(page, `${base}${home}`);
      await markDocument(page);
      // A zero-height (popover) container; the visible part is its `.bar`.
      const progress = page.locator('#nprogress');
      const bar = progress.locator('.bar');
      let held = await gate(page, '**/features/slow', 'GET');
      await page.getByRole('link', { name: 'Slow page', exact: true }).click();
      await held.held;
      // The client starts the bar after its 250 ms delay, in the configured colour.
      await wait(bar).toBeVisible();
      await expect(progress).toHaveAttribute('aria-hidden', 'true');
      await expect(bar).toHaveCSS('background-color', 'rgb(29, 78, 216)');
      held.release();
      await wait(page.getByTestId('loaded')).toHaveText(
        'Loaded from the server',
      );
      await wait(progress).toHaveCount(0);
      await page.unrouteAll();
      await page.goBack();
      await wait(
        page.getByRole('button', { name: 'Quiet slow visit' }),
      ).toBeVisible();
      held = await gate(page, '**/features/slow', 'GET');
      await page.getByRole('button', { name: 'Quiet slow visit' }).click();
      await held.held;
      // Past the delay the client marks the document busy, but the bar stays hidden.
      await wait(page.locator('html')).toHaveClass(/nprogress-busy/);
      await expect(bar).toBeHidden();
      held.release();
      await wait(page.getByTestId('loaded')).toHaveText(
        'Loaded from the server',
      );
      expect(await sameDocument(page)).toBe(true);
    });
  });
}

const bindings = {
  React: 'React hook',
  Vue: 'Vue composable',
  Svelte: 'Svelte store',
} as const;

/**
 * `/features/actions`: the `notes.add` server action through the binding the
 * actions codegen generated for the framework (`useNotesAdd()`,
 * `useNotesAdd()` composable, `notesAdd()` store), with initial data from the
 * page props, an optimistic value, rollback and typed validation issues.
 */
export function defineTypedActionsSuite({
  framework,
  base,
}: FrameworkSuite): void {
  const binding = bindings[framework];
  test.describe(`Inertia ${framework} typed server actions`, () => {
    test.describe.configure({ timeout: 90000 });

    test(`typed server actions run through the generated ${binding} on an Inertia page`, async ({
      page,
      browserName,
    }) => {
      const observed = await observe(page);
      await open(page, `${base}/features/actions`);
      await markDocument(page);
      const status = page.getByTestId('notes-status');
      const notes = page.getByTestId('notes').getByRole('listitem');
      // Exact: the list's accessible name is "Notes".
      const noteField = page.getByLabel('Note', { exact: true });
      await expect(status).toHaveText('idle: 0 notes');
      const endpoint = '**/_nestvexa/actions/notes/add';
      const text = `Hook note ${browserName}`;
      let held = await gate(page, endpoint, 'POST');
      const call = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === '/_nestvexa/actions/notes/add',
      );
      await noteField.fill(text);
      await page.getByRole('button', { name: 'Add note' }).click();
      await held.held;
      const sent = await call;
      expect(sent.postDataJSON()).toEqual({ input: { text } });
      expect(sent.headers()['x-nestvexa-csrf']).toBeTruthy();
      // The optimistic board shows while the call is parked in the browser.
      await wait(status).toHaveText('pending: 1 notes');
      await expect(status).toHaveAttribute('data-optimistic', 'true');
      await expect(notes).toHaveText([text]);
      held.release();
      await wait(status).toHaveText('success: 1 notes');
      await expect(status).toHaveAttribute('data-optimistic', 'false');
      await expect(noteField).toHaveValue('');
      await page.unrouteAll();
      // A validation failure rolls the optimistic value back and types the issue.
      held = await gate(page, endpoint, 'POST');
      await noteField.fill('fail');
      await page.getByRole('button', { name: 'Add note' }).click();
      await held.held;
      await wait(notes).toHaveText(['fail', text]);
      held.release();
      await wait(page.locator('#note-error')).toHaveText(
        'The server rejected this note.',
      );
      await expect(status).toHaveText('error: 1 notes');
      await expect(notes).toHaveText([text]);
      await expect(noteField).toHaveAttribute('aria-invalid', 'true');
      await page.unrouteAll();
      expect(await sameDocument(page)).toBe(true);
      // The server kept the note for this session: a fresh document shows it.
      await page.reload();
      await hydrated(page);
      await expect(status).toHaveText('idle: 1 notes');
      await expect(notes).toHaveText([text]);
      // The endpoint refuses calls without the CSRF token or from another origin.
      const token = (await page.context().cookies(base)).find(
        (cookie) => cookie.name === 'XSRF-TOKEN',
      )?.value;
      expect(token).toBeTruthy();
      const url = `${base}/_nestvexa/actions/notes/add`;
      const body = { input: { text: 'forged' } };
      const missing = await page.request.post(url, {
        headers: { origin: base },
        data: body,
      });
      expect(missing.status()).toBe(403);
      const foreign = await page.request.post(url, {
        headers: {
          origin: 'https://evil.example',
          'x-nestvexa-csrf': token ?? '',
        },
        data: body,
      });
      expect(foreign.status()).toBe(403);
      await page.reload();
      await hydrated(page);
      await expect(status).toHaveText('idle: 1 notes');
      expect(observed.errors).toEqual([]);
    });
  });
}
