import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// examples/islands-vite: React, Vue and Svelte islands built and served
// through @nestvexa/vite. Production: Vite client build + islandsVitePlugin
// manifest, `vite build --ssr` renderers, a manifest-only loader tagged with
// the request nonce. Development: the Vite dev middleware with ssrLoadModule.

const production =
  process.env['NESTVEXA_E2E_ISLANDS_VITE_URL'] ?? 'http://127.0.0.1:3479';
const development =
  process.env['NESTVEXA_E2E_ISLANDS_VITE_DEV_URL'] ?? 'http://127.0.0.1:3475';
const islands = [
  { id: 'counter-react', count: '#react-count', label: 'React', start: 1 },
  { id: 'counter-vue', count: '#vue-count', label: 'Vue', start: 2 },
  { id: 'counter-svelte', count: '#svelte-count', label: 'Svelte', start: 3 },
] as const;

interface Diagnostic {
  readonly id: string;
  readonly state: string;
  readonly hydration: string;
}

async function watch(page: Page): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { nvCsp: string[] }).nvCsp = violations;
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return { errors };
}

async function expectHydrated(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            (
              window as unknown as {
                nvIslands?: { diagnostics(): readonly Diagnostic[] };
              }
            ).nvIslands?.diagnostics() ?? []
          ).map(({ id, state, hydration }) => `${id}:${state}:${hydration}`),
        ),
      { timeout: 30_000 },
    )
    .toEqual(islands.map(({ id }) => `${id}:mounted:hydrated`));
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nvIslandMismatches?: string[] })
          .nvIslandMismatches,
    ),
  ).toEqual([]);
  for (const island of islands) {
    const count = page.locator(island.count);
    await page
      .getByRole('button', { name: `Increment ${island.label}` })
      .click();
    await expect(count).toHaveText(
      `${island.label} clicks: ${island.start + 1}`,
    );
  }
  expect(
    await page.evaluate(() => (window as unknown as { nvCsp: string[] }).nvCsp),
  ).toEqual([]);
}

test.describe('islands built through Vite (production)', () => {
  test('SSR markup from the Vite SSR bundle and a nonce-tagged loader', async ({
    request,
  }) => {
    const response = await request.get(`${production}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const policy = response.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toMatch(
      new RegExp(
        `<script type="module" src="/build/assets/loader-[\\w-]+\\.js" nonce="${(nonce ?? '').replace(/[+/=]/g, '\\$&')}"></script>`,
      ),
    );
    for (const island of islands) {
      expect(html).toMatch(
        new RegExp(`data-nv-island="${island.id}"[^>]*data-nv-ssr=""`),
      );
      // React separates text nodes with `<!-- -->` comments.
      expect(html).toMatch(
        new RegExp(
          `${island.label} clicks(?:<!-- -->)?: (?:<!-- -->)?${island.start}<`,
        ),
      );
    }
    // Build metadata stays private: dot directories are never served.
    for (const file of [
      'islands-manifest.json',
      'islands-metafile.json',
      'manifest.json',
    ])
      expect(
        (await request.get(`${production}/islands/.vite/${file}`)).status(),
      ).toBe(404);
  });

  test('hydrates React, Vue and Svelte without mismatches or CSP violations', async ({
    page,
  }) => {
    const { errors } = await watch(page);
    await page.goto(`${production}/`);
    await expectHydrated(page);
    expect(errors).toEqual([]);
  });

  test('loads islands only from their manifest bundle paths', async ({
    page,
  }) => {
    const manifest = JSON.parse(
      await readFile(
        'examples/islands-vite/dist/islands/.vite/islands-manifest.json',
        'utf8',
      ),
    ) as { islands: Record<string, { bundle: string }> };
    const bundles = new Set(
      Object.values(manifest.islands).map((entry) => entry.bundle),
    );
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script')
        scripts.push(new URL(request.url()).pathname);
    });
    const { errors } = await watch(page);
    await page.goto(`${production}/`);
    await expectHydrated(page);
    expect(errors).toEqual([]);
    const islandScripts = scripts.filter((path) =>
      path.startsWith('/islands/'),
    );
    for (const bundle of bundles) expect(islandScripts).toContain(bundle);
    // Everything else is the loader or a shared chunk of the islands build.
    for (const path of scripts)
      expect(path).toMatch(/^\/(?:build|islands)\/assets\/[\w-]+\.js$/);
  });

  test('the bundled manifest schema refuses tampered props before mounting', async ({
    page,
  }) => {
    await page.route(`${production}/`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '{&quot;label&quot;:&quot;Svelte clicks&quot;,&quot;start&quot;:3}',
        '{&quot;label&quot;:&quot;Svelte clicks&quot;,&quot;start&quot;:5000}',
      );
      await route.fulfill({ response, body });
    });
    await page.goto(`${production}/`);
    const svelte = page.locator('[data-nv-island="counter-svelte"]');
    await expect(svelte).toHaveAttribute('data-nv-island-failed', '', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Increment Svelte' }).click();
    await expect(page.locator('#svelte-count')).toHaveText('Svelte clicks: 3');
    // The other islands are unaffected.
    await page.getByRole('button', { name: 'Increment React' }).click();
    await expect(page.locator('#react-count')).toHaveText('React clicks: 2');
  });
});

test.describe('islands through the Vite dev middleware', () => {
  test.setTimeout(120_000);

  test('dev SSR through ssrLoadModule hydrates with HMR-capable modules', async ({
    page,
    request,
  }) => {
    const html = await (await request.get(`${development}/`)).text();
    expect(html).toContain('/islands/@vite/client');
    expect(html).toContain('/islands/client/loader.dev.ts');
    for (const island of islands)
      expect(html).toMatch(
        new RegExp(`data-nv-island="${island.id}"[^>]*data-nv-ssr=""`),
      );
    const { errors } = await watch(page);
    await page.goto(`${development}/`);
    await expectHydrated(page);
    expect(errors).toEqual([]);
  });
});
