import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Per-adapter Vite dev mode: each Inertia example runs with
// createViteDevServer middleware (HMR socket on the Nest HTTP server, SSR via
// ssrLoadModule) from a disposable copy started by tests/browser/hmr-fixture.mjs.
// A page source edit on disk must hot-update the open page without a full
// reload, and the next server render must contain the edit.

interface Root {
  readonly url: string;
  readonly page: string;
  /** Whether the framework's HMR keeps component state across this edit. */
  readonly keepsState: boolean;
}
const roots: Readonly<Record<'react' | 'vue' | 'svelte', Root>> = {
  // React Fast Refresh keeps hook state for an edited function component.
  react: {
    url: process.env['NESTVEXA_E2E_REACT_DEV_URL'] ?? 'http://127.0.0.1:3476',
    page: 'client/pages/Home.tsx',
    keepsState: true,
  },
  // A template-only change re-renders the Vue component in place.
  vue: {
    url: process.env['NESTVEXA_E2E_VUE_DEV_URL'] ?? 'http://127.0.0.1:3477',
    page: 'client/pages/Home.vue',
    keepsState: true,
  },
  // Svelte 5 HMR re-creates the edited component in place: no reload, but
  // its local $state starts over.
  svelte: {
    url: process.env['NESTVEXA_E2E_SVELTE_DEV_URL'] ?? 'http://127.0.0.1:3478',
    page: 'client/pages/Home.svelte',
    keepsState: false,
  },
};
const markerPattern = /\[\[hmr:[^\]]*\]\]/;

/** Cross-process lock: browser projects share one dev server and source file. */
async function locked<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const lock = `${directory}/.hmr-lock`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`HMR lock ${lock} is stuck`);
      await delay(250);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lock);
  }
}

async function hydrated(page: Page): Promise<void> {
  const count = page.getByTestId('hmr-count');
  // A click before hydration does nothing, so retry until the client owns the page.
  await expect(async () => {
    await page.getByRole('button', { name: 'Count up' }).click();
    await expect(count).not.toHaveText('Count 0', { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
}

for (const [framework, root] of Object.entries(roots)) {
  test.describe(`${framework} Inertia root in Vite dev mode`, () => {
    test.setTimeout(180_000);

    test('serves SSR markup and the Vite client through the dev middleware', async ({
      page,
      request,
    }) => {
      const response = await request.get(`${root.url}/`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-testid="hmr-marker"');
      expect(html).toMatch(/<script type="module" src="\/[^"]*@vite\/client"/);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${root.url}/`);
      await hydrated(page);
      expect(errors).toEqual([]);
    });

    test('a page edit hot-updates without a full reload and dev SSR renders it', async ({
      page,
      request,
      browserName,
    }) => {
      const directory = `artifacts/hmr-inertia-${framework}`;
      const file = `${directory}/${root.page}`;
      await page.goto(`${root.url}/`);
      await hydrated(page);
      const count = page.getByTestId('hmr-count');
      await page.getByRole('button', { name: 'Count up' }).click();
      const before = await count.textContent();
      await page.evaluate(() => {
        (window as unknown as { nvHmrProbe?: string }).nvHmrProbe = 'kept';
      });
      await locked(directory, async () => {
        const original = await readFile(file, 'utf8');
        const marker = `[[hmr:${browserName}-${Date.now()}]]`;
        try {
          await writeFile(file, original.replace(markerPattern, marker));
          await expect(page.getByTestId('hmr-marker')).toHaveText(marker, {
            timeout: 60_000,
          });
          // Same document: a full reload would have dropped the window marker.
          expect(
            await page.evaluate(
              () => (window as unknown as { nvHmrProbe?: string }).nvHmrProbe,
            ),
          ).toBe('kept');
          await expect(count).toHaveText(
            root.keepsState ? (before ?? '') : 'Count 0',
          );
          const html = await (await request.get(`${root.url}/`)).text();
          expect(html).toContain(marker);
        } finally {
          await writeFile(file, original);
        }
      });
    });
  });
}
