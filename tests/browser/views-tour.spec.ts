import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { exampleUrl } from './example-url.js';

/**
 * examples/views-tour: view namespaces and application overrides, themes,
 * permission helpers and opt-in error pages through the `nestvexa` umbrella
 * (VIEW-006/018/021/026), plus `nv:cloak` (DIR-022), `nv:class` (DIR-025) and
 * a `lazy: 'visible'` Live component (BROW-015) on the same server.
 */
test.use({ baseURL: exampleUrl('views-tour', 4100) });
test.describe.configure({ timeout: 60_000 });

/** Collects CSP violations from the first script onwards. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const list: string[] = [];
    Reflect.set(window, 'nvViolations', list);
    document.addEventListener('securitypolicyviolation', (event) =>
      list.push(event.violatedDirective),
    );
  });
  return () =>
    page.evaluate(() => {
      const list: unknown = Reflect.get(window, 'nvViolations');
      return Array.isArray(list) ? list.map(String) : ['missing'];
    });
}

test.describe('views through the umbrella', () => {
  test('namespaced views render and the application vendor override wins', async ({
    page,
  }) => {
    await page.goto('/admin');
    await expect(page.locator('#admin-source')).toHaveAttribute(
      'data-source',
      'admin-namespace',
    );
    await expect(page).toHaveTitle('Admin dashboard');
    await page.goto('/admin/settings');
    await expect(page.locator('#admin-source')).toHaveAttribute(
      'data-source',
      'app-override',
    );
  });

  test('a registered theme overrides the layout; unknown themes fall back', async ({
    page,
  }) => {
    await page.goto('/?theme=dark');
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
    await expect(page).toHaveTitle('Nestvexa views tour (dark)');
    await expect(page.locator('#theme')).toHaveText('Theme: dark');
    await page.goto('/?theme=..%2Fsecret');
    await expect(page.locator('body')).toHaveAttribute('data-theme', 'default');
    await expect(page.locator('#theme')).toHaveText('Theme: default');
  });

  test('permission helpers show only the controls the role may use', async ({
    page,
  }) => {
    await page.goto('/posts?role=editor');
    await expect(page.locator('#post-edit')).toBeVisible();
    await expect(page.locator('#post-readonly')).toHaveCount(0);
    await page.goto('/posts?role=viewer');
    await expect(page.locator('#post-view')).toBeVisible();
    await expect(page.locator('#post-edit')).toHaveCount(0);
    await expect(page.locator('#post-readonly')).toBeVisible();
    // Unknown roles fail closed.
    await page.goto('/posts?role=__proto__');
    await expect(page.locator('#post-view')).toHaveCount(0);
    await page.goto('/posts/granted?role=editor');
    await expect(page.locator('#granted-edit')).toBeVisible();
    await expect(page.locator('#granted-delete')).toHaveCount(0);
    await page.goto('/posts/granted?role=viewer');
    await expect(page.locator('#granted-none')).toBeVisible();
  });

  test('error pages render views for browsers and JSON for API clients', async ({
    page,
  }) => {
    const missing = await page.goto('/missing');
    expect(missing?.status()).toBe(404);
    await expect(page.locator('#error-heading')).toHaveText('404 Not Found');
    await expect(page).toHaveTitle('Not Found');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const boom = await page.goto('/boom');
    expect(boom?.status()).toBe(500);
    await expect(page.locator('#error-heading')).toHaveText(
      '500 Internal Server Error',
    );
    expect(await page.content()).not.toContain('do-not-show');
    const api = await page.request.get('/boom', {
      headers: { accept: 'application/json' },
    });
    expect(api.status()).toBe(500);
    expect(await api.json()).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });
});

test.describe('nv:cloak', () => {
  test('cloaked content stays hidden until the runtime has initialized it', async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/_nestvexa/boot.js', async (route: Route) => {
      await held;
      await route.continue();
    });
    // A pending module script also holds DOMContentLoaded, so wait for the
    // response and the parsed element instead.
    await page.goto('/', { waitUntil: 'commit' });
    const cloaked = page.locator('#tour-cloaked');
    await expect(cloaked).toBeAttached();
    // Server HTML is present but the shipped [nv\:cloak] rule hides it.
    await expect(cloaked).toHaveAttribute('nv:cloak', '');
    await expect(cloaked).toBeHidden();
    expect(
      await cloaked.evaluate((element) => getComputedStyle(element).display),
    ).toBe('none');
    await page.waitForTimeout(300);
    await expect(cloaked).toBeHidden();
    release();
    await expect(cloaked).toBeVisible();
    await expect(cloaked).not.toHaveAttribute('nv:cloak', '');
    await expect(page.locator('[data-nv-component]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    expect(await violations()).toEqual([]);
  });

  test('cloaked content stays hidden when the runtime never starts', async ({
    page,
  }) => {
    await page.route('**/_nestvexa/boot.js', (route: Route) => route.abort());
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await expect(page.locator('#tour-cloaked')).toBeHidden();
    await expect(page.locator('#tour-cloaked')).toHaveAttribute('nv:cloak', '');
  });
});

test.describe('nv:class', () => {
  test('toggles CSS classes from boolean state without inline styles or CSP reports', async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    await page.goto('/');
    const status = page.locator('#tour-status');
    await expect(page.locator('#tour-cloaked')).toBeVisible();
    await expect(status).toHaveClass('tour-status');
    await page.getByRole('button', { name: 'Toggle urgent' }).click();
    await expect(page.locator('#tour-toggles')).toHaveText('1');
    await expect(status).toHaveClass('tour-status is-urgent');
    await page.getByRole('button', { name: 'Toggle archived' }).click();
    await expect(page.locator('#tour-toggles')).toHaveText('2');
    await expect(status).toHaveClass(/\bis-urgent\b/);
    await expect(status).toHaveClass(/\bis-archived\b/);
    await page.getByRole('button', { name: 'Toggle urgent' }).click();
    await expect(page.locator('#tour-toggles')).toHaveText('3');
    await expect(status).not.toHaveClass(/\bis-urgent\b/);
    await expect(status).toHaveClass(/\bis-archived\b/);
    expect(await status.getAttribute('style')).toBeNull();
    expect(await violations()).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test.describe('lazy Live component with the visible strategy', () => {
  test('mounts once, only after scrolling into view, and stays accessible', async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    const loads: string[] = [];
    page.on('request', (request: Request) => {
      if (request.method() === 'POST' && request.url().includes('/tour-feed/'))
        loads.push(new URL(request.url()).pathname);
    });
    await page.goto('/lazy');
    const feed = page.locator('[data-nv-name="tour-feed"]');
    await expect(feed).toHaveAttribute('data-nv-lazy', 'visible');
    const placeholder = page.locator('#tour-feed-placeholder');
    await expect(placeholder).toHaveAttribute('role', 'status');
    await expect(placeholder).toHaveAttribute('aria-busy', 'true');
    // The runtime is up (the component is registered), yet nothing loads off-screen.
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(600);
    expect(loads).toEqual([]);
    expect(
      await feed.evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThan(await page.evaluate(() => window.innerHeight));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await feed.scrollIntoViewIfNeeded();
    await expect(page.locator('#tour-feed-heading')).toHaveText(
      'Latest updates',
    );
    await expect(page.locator('#tour-feed li')).toHaveText([
      'Namespaced views',
      'Theme overrides',
      'Error pages',
    ]);
    await expect(placeholder).toHaveCount(0);
    await expect(feed).not.toHaveAttribute('data-nv-lazy', 'visible');
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    expect(loads).toEqual(['/_nestvexa/live/tour-feed/_sync']);

    // Leaving and re-entering the viewport does not mount it again.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await feed.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    expect(loads).toHaveLength(1);
    expect(await violations()).toEqual([]);
    expect(
      (await new AxeBuilder({ page }).include('#tour-feed').analyze())
        .violations,
    ).toEqual([]);
  });
});
