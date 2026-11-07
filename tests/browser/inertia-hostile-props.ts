import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cspViolations, hydrated, observe } from './inertia-framework-suite.js';

// SEC-022: hostile Inertia page props in the Vue and Svelte examples
// (`/__test/hostile`, src/hostile.ts, --test-controls only). Every payload
// would set `window.__nvXss` if it ever became markup, an event handler, a
// script or a template expression. The pages are also served under a nonce
// CSP, so "nothing ran" alone is weak evidence: these tests check the DOM and
// the raw server HTML for injected structure, and that no CSP violation fired
// (a blocked injected handler or script would report one).

/** The exact props the examples serve; pinned so a weakened list fails. */
const payloads = [
  '<script>window.__nvXss = "script"</script>',
  '<img src="x" onerror="window.__nvXss = \'onerror\'">',
  '<svg onload="window.__nvXss = \'svg\'"></svg>',
  '" onmouseover="window.__nvXss = \'attribute\'" data-x="',
  "' autofocus onfocus='window.__nvXss = \"single-quote\"' '",
  '</script><script>window.__nvXss = "closing"</script>',
  '<!--<script>window.__nvXss = "comment"</script>-->',
  '{{ constructor.constructor("window.__nvXss = \'vue-template\'")() }}',
  '{constructor.constructor("window.__nvXss = \'svelte-template\'")()}',
  '${window.__nvXss = "template-literal"}',
  'line separator paragraph',
];
const links = [
  "javascript:window.__nvXss = 'javascript'",
  "JaVaScRiPt:window.__nvXss = 'mixed-case'",
  "java\tscript:window.__nvXss = 'tab'",
  " \njavascript:window.__nvXss = 'leading-space'",
  'data:text/html,<script>window.__nvXss = "data"</script>',
  'vbscript:msgbox(1)',
  '/users',
  'https://example.test/docs',
];
const allowedLinks = new Set(['/users', 'https://example.test/docs']);
const path = '/__test/hostile';

export interface HostilePropsSuite {
  readonly framework: 'Vue' | 'Svelte';
  /** SSR + hydration instance. */
  readonly base: string;
  /** Same build with SSR disabled (client-only mount from the page JSON). */
  readonly clientOnlyBase: string;
}

/** Structure the payloads must never create anywhere in the document. */
async function injectedStructure(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      for (const { name } of element.attributes)
        if (/^on/i.test(name))
          found.push(`${element.tagName.toLowerCase()}[${name}]`);
      if (element.hasAttribute('autofocus'))
        found.push(`${element.tagName.toLowerCase()}[autofocus]`);
      if (
        element.closest('main') &&
        ['IMG', 'SVG', 'svg'].includes(element.tagName)
      )
        found.push(element.tagName.toLowerCase());
    }
    for (const script of document.scripts)
      if (script.textContent?.includes('__nvXss') && !script.dataset['page'])
        found.push('script');
    if (Reflect.has(window, '__nvXss'))
      found.push(`executed:${String(Reflect.get(window, '__nvXss'))}`);
    return found;
  });
}

async function checkRendered(page: Page): Promise<void> {
  const items = page.getByTestId('payload');
  await expect(items).toHaveCount(payloads.length);
  // Text and attribute bindings hold the exact strings, character for character.
  const rendered = await items.evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent?.trim() ?? '',
      title: element.getAttribute('title'),
      data: element.getAttribute('data-payload'),
      children: element.children.length,
    })),
  );
  expect(rendered).toEqual(
    payloads.map((payload) => ({
      text: payload.trim(),
      title: payload,
      data: payload,
      children: 0,
    })),
  );
  // Mouse and focus events would fire an injected handler. Dispatched
  // directly: pointer hovers on 11 items time out on loaded WebKit hosts.
  for (const item of await items.all()) {
    await item.dispatchEvent('mouseover');
    await item.dispatchEvent('focus');
  }
  await page.keyboard.press('Tab');
  // URL bindings: only http(s) and relative links keep their target.
  const anchors = page.getByTestId('link');
  await expect(anchors).toHaveCount(links.length);
  const hrefs = await anchors.evaluateAll((elements) =>
    elements.map((element) => ({
      raw: element.getAttribute('data-raw'),
      href: element.getAttribute('href'),
      text: element.textContent,
    })),
  );
  expect(hrefs).toEqual(
    links.map((link) => ({
      raw: link,
      href: allowedLinks.has(link) ? link : '#',
      text: link,
    })),
  );
  // Clicking a neutralized link stays on the page and runs nothing.
  await anchors.first().click();
  await expect(page.locator('h1')).toHaveText('Hostile page props');
  expect(await page.title()).toContain(payloads[0]);
  expect(await injectedStructure(page)).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
}

export function defineHostilePropsSuite({
  framework,
  base,
  clientOnlyBase,
}: HostilePropsSuite): void {
  test.describe(`Inertia ${framework} hostile page props`, () => {
    test.describe.configure({ timeout: 90000 });

    test('server HTML and the Inertia JSON carry the payloads only as escaped data', async ({
      request,
      browser,
    }) => {
      const response = await request.get(`${base}${path}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      const page =
        /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/.exec(
          html,
        );
      expect(page).not.toBeNull();
      // The embedded page JSON never closes its script element early and
      // round-trips to exactly the served props.
      const embedded = page?.[1] ?? '';
      expect(embedded).not.toMatch(/<\/script|<!--|<script/i);
      const object = JSON.parse(embedded) as {
        props: { payloads: string[]; links: string[] };
      };
      expect(object.props.payloads).toEqual(payloads);
      expect(object.props.links).toEqual(links);
      // Outside the page JSON the SSR markup contains no payload tag and no
      // unfiltered URL. Quote characters in text may legitimately stay raw (a
      // quote is inert in text content); the DOM checks cover attributes.
      const markup = html.replace(page?.[0] ?? '', '');
      expect(markup).toContain('data-server-rendered="true"');
      for (const needle of [
        '<img src="x"',
        '<svg onload',
        '<script>window.__nvXss',
        'href="javascript:',
        'href="data:',
      ])
        expect(markup).not.toContain(needle);
      // Without JavaScript the server markup alone is inert.
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const noScript = await context.newPage();
        await noScript.goto(`${base}${path}`);
        await expect(noScript.getByTestId('payload')).toHaveCount(
          payloads.length,
        );
        expect(await injectedStructure(noScript)).toEqual([]);
      } finally {
        await context.close();
      }
      // An Inertia visit gets the same props as JSON, never as HTML.
      const version = /"version":"([^"]*)"/.exec(embedded)?.[1] ?? '';
      const json = await request.get(`${base}${path}`, {
        headers: { 'X-Inertia': 'true', 'X-Inertia-Version': version },
      });
      expect(json.status()).toBe(200);
      expect(json.headers()['content-type']).toMatch(/^application\/json/);
      const visit = (await json.json()) as {
        props: { payloads: string[]; links: string[] };
      };
      expect(visit.props.payloads).toEqual(payloads);
    });

    test('hydration renders every payload inert', async ({ page }) => {
      const observed = await observe(page);
      await page.goto(`${base}${path}`);
      await hydrated(page);
      await checkRendered(page);
      expect(observed.errors).toEqual([]);
    });

    test('a client-only mount renders every payload inert', async ({
      page,
    }) => {
      const observed = await observe(page);
      await page.goto(`${clientOnlyBase}${path}`);
      await checkRendered(page);
      expect(observed.errors).toEqual([]);
    });

    test('an Inertia visit renders the JSON props inert', async ({ page }) => {
      const observed = await observe(page);
      await page.goto(`${base}${path}`);
      await hydrated(page);
      const visit = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path &&
          response.request().headers()['x-inertia'] === 'true',
      );
      await page.getByTestId('revisit').click();
      const response = await visit;
      expect(response.headers()['content-type']).toMatch(/^application\/json/);
      await checkRendered(page);
      expect(observed.errors).toEqual([]);
    });
  });
}
