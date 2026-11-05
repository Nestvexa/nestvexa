import { expect, test } from '@playwright/test';
import {
  hydrated,
  inertiaRequests,
  markDocument,
  observe,
  sameDocument,
} from './inertia-framework-suite.js';
import type { FrameworkSuite } from './inertia-framework-suite.js';

// Shared smoke flows for client-owned Inertia v3 features and the
// client-only (SSR disabled) mode of examples/inertia-{react,vue,svelte}. The
// React example additionally runs the full tour in inertia-react-features.

const wait = expect.configure({ timeout: 15000 });

/** Prefetch, polling, WhenVisible and infinite scroll with the official client. */
export function defineFeatureSmoke({ framework, base }: FrameworkSuite): void {
  test.describe(`Inertia ${framework} client features smoke`, () => {
    test.describe.configure({ timeout: 90000 });

    test('prefetches on hover and reuses the response on click', async ({
      page,
    }) => {
      await page.goto(`${base}/features`);
      await hydrated(page);
      const requests = inertiaRequests(page);
      const prefetched = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/features/prefetched' &&
          /prefetch/.test(response.request().headers()['purpose'] ?? ''),
      );
      const link = page.getByRole('link', { name: 'Prefetched page' });
      await link.hover();
      const body = (await (await prefetched).json()) as {
        props: { renders: number };
      };
      await markDocument(page);
      await link.click();
      await wait(page.getByTestId('renders')).toHaveText(
        `Server renders: ${body.props.renders}`,
      );
      expect(
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/features/prefetched',
        ),
      ).toHaveLength(1);
      expect(await sameDocument(page)).toBe(true);
    });

    test('polls with partial reloads, stops, and loads WhenVisible data on scroll', async ({
      page,
    }) => {
      await page.goto(`${base}/features`);
      await hydrated(page);
      const requests = inertiaRequests(page);
      const first = Number(
        (await page.getByTestId('tick').textContent())?.replace('Tick ', ''),
      );
      await wait(page.getByTestId('tick')).toHaveText(`Tick ${first + 2}`);
      const polls = requests.filter(
        (request) => request.headers()['x-inertia-partial-data'] === 'tick',
      );
      expect(polls.length).toBeGreaterThanOrEqual(2);
      await page.getByRole('button', { name: 'Stop polling' }).click();
      await wait(page.getByTestId('polling')).toHaveText('Stopped');
      await expect(page.getByTestId('below')).toHaveText('Not loaded yet');
      expect(
        requests.some(
          (request) => request.headers()['x-inertia-partial-data'] === 'below',
        ),
      ).toBe(false);
      await page.getByTestId('below').scrollIntoViewIfNeeded();
      await wait(page.getByTestId('below')).toHaveText('Loaded when visible');
      expect(
        requests.filter(
          (request) => request.headers()['x-inertia-partial-data'] === 'below',
        ),
      ).toHaveLength(1);
    });

    test('infinite scroll appends every server page without duplicates', async ({
      page,
    }) => {
      await page.goto(`${base}/features/scroll`);
      await hydrated(page);
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
      expect(new Set(labels.map((label) => label.trim())).size).toBe(45);
      expect(
        requests
          .filter(
            (request) =>
              request.headers()['x-inertia-partial-data'] === 'items',
          )
          .map((request) => new URL(request.url()).searchParams.get('page')),
      ).toEqual(['2', '3']);
    });
  });
}

/**
 * Client-only mode (SSR disabled in the Nest app): the document carries only
 * the page script and an empty root; the official client mounts, navigates
 * and submits forms.
 */
export function defineClientOnlySuite({
  framework,
  base,
}: FrameworkSuite): void {
  test.describe(`Inertia ${framework} client-only mode (SSR off)`, () => {
    test.describe.configure({ timeout: 90000 });

    test('serves an empty root and mounts, navigates and validates on the client', async ({
      page,
      request,
    }) => {
      const html = await (await request.get(`${base}/`)).text();
      expect(html).not.toContain('data-server-rendered');
      expect(html).toContain('<div id="app"></div>');
      expect(html.match(/<script data-page="app"/g)).toHaveLength(1);
      const observed = await observe(page);
      await page.goto(`${base}/`);
      await hydrated(page);
      await expect(
        page.getByRole('heading', {
          name: `Welcome to Nestvexa + ${framework}`,
        }),
      ).toBeVisible();
      await markDocument(page);
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Users' })
        .click();
      await wait(
        page.getByRole('heading', { name: 'Users', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'New user' }).click();
      await page.getByRole('button', { name: 'Save' }).click();
      await wait(page.locator('#name-error')).toHaveText(
        'The name field is required.',
      );
      const name = `${framework} CSR ${Date.now()}`;
      await page.getByLabel('Name').fill(name);
      await page.getByLabel('Email').fill('csr@example.test');
      await page.getByRole('button', { name: 'Save' }).click();
      await wait(page.getByTestId('flash')).toHaveText(`User ${name} created`);
      expect(await sameDocument(page)).toBe(true);
      expect(observed.errors).toEqual([]);
      expect(observed.console).toEqual([]);
    });
  });
}
