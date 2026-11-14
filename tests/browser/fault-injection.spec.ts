import { expect, test } from '@playwright/test';
import type { Page, Request, Route, TestInfo } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { labUrl, openLab, sameDocument } from './browser-lab.js';

// Fault injection (QA-073) against real servers: a session destroyed while a
// Live action is in flight, a session that expires mid-action, a backend
// restart between state updates, unavailable client/Alpine assets with the
// no-JS fallback, and a throttled slow network. The fault server
// (tests/support/fault-server.ts) is started, killed and restarted by this
// spec on its own port; every run asserts the server never logged an
// unhandled rejection (it runs with --unhandled-rejections=strict, so one
// would also crash it and fail the next request).

const incrementUrl = '**/_nestvexa/live/*/increment';

async function errorCodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const codes: string[] = [];
    document.addEventListener('nestvexa:error', (event) => {
      const detail: unknown = (event as CustomEvent).detail;
      codes.push(String(Reflect.get(Object(detail), 'code')));
    });
    Reflect.set(window, 'nvErrorCodes', codes);
  });
}
const reportedCodes = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'nvErrorCodes') as string[]);

interface Reply {
  readonly status: number;
  readonly body: string;
}
/**
 * Record every increment reply as the browser receives it (bodies are read
 * in the route) and let a test hold the next request on the wire.
 */
async function captureIncrements(page: Page) {
  const seen: Reply[] = [];
  let gate:
    { readonly held: () => void; readonly released: Promise<void> } | undefined;
  await page.route(incrementUrl, async (route: Route) => {
    const current = gate;
    gate = undefined;
    if (current) {
      current.held();
      await current.released;
    }
    const response = await route.fetch();
    const body = await response.text();
    seen.push({ status: response.status(), body });
    await route.fulfill({ response, body });
  });
  return {
    seen,
    /** Hold the next increment until `release` is called. */
    holdNext() {
      let held: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        held = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { held, released };
      return { reached, release };
    },
  };
}

test.describe('browser-lab sessions and assets', () => {
  test('a session destroyed while an action is in flight fails safely and recovers', async ({
    page,
  }) => {
    const errors = await openLab(page);
    await errorCodes(page);
    const { seen, holdNext } = await captureIncrements(page);
    await page.locator('#increment').click();
    await expect(page.locator('#count')).toHaveText('1');

    // The next action is on the wire when another tab signs out.
    const gate = holdNext();
    await page.locator('#increment').click();
    await gate.reached;
    const logout = await page.request.post(labUrl + '/logout', {
      headers: { origin: labUrl },
    });
    expect(logout.status()).toBe(201);
    gate.release();

    await expect
      .poll(() => seen.map((reply) => reply.status))
      .toEqual([201, 401]);
    // The refusal names no state, identity or token.
    const body = seen[1]?.body ?? '';
    expect(JSON.parse(body)).toMatchObject({ statusCode: 401 });
    expect(body).not.toMatch(/count|guest-session|csrf|snapshot/i);
    await expect.poll(() => reportedCodes(page)).toEqual(['HTTP']);
    // Nothing was applied: the DOM keeps the last authorized render.
    await expect(page.locator('#count')).toHaveText('1');
    expect(await sameDocument(page)).toBe(true);

    // A reload starts a new session with fresh state that works.
    await page.reload();
    await page.evaluate(async () => {
      await import('/_nestvexa/boot.js' as string);
    });
    await expect(page.locator('#count')).toHaveText('0');
    await page.locator('#increment').click();
    await expect(page.locator('#count')).toHaveText('1');
    expect(errors).toEqual([]);
  });

  for (const [label, pattern] of [
    ['client runtime', /\/_nestvexa\/(?:boot\.js|assets\/)/],
    ['Alpine module', /\/_nestvexa\/assets\/[^/]+\/alpine\.js$/],
  ] as const)
    test(`the page stays usable without JavaScript when the ${label} is unavailable`, async ({
      page,
    }) => {
      const failed: string[] = [];
      await page.route(pattern, (route) => {
        failed.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 404, body: 'gone' });
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(labUrl + '/');
      await expect(page.locator('h1')).toHaveText('Browser lab');
      await expect.poll(() => failed.length).toBeGreaterThan(0);
      // The server-rendered state and controls are present.
      await expect(page.locator('#count')).toHaveText('0');
      await expect(page.locator('#increment')).toBeVisible();
      // The form posts natively to its host route and the redirect shows the
      // saved note: the no-JavaScript path of the same feature.
      await page.locator('#note').fill('saved without js');
      await Promise.all([
        page.waitForURL(labUrl + '/'),
        page.getByRole('button', { name: 'Save note' }).click(),
      ]);
      await expect(page.locator('#host-note')).toHaveText('saved without js');
      // Plain links keep navigating.
      await page.locator('#native-long').click();
      await expect(page).toHaveURL(labUrl + '/long');
      // A missing module is a load failure, not a script error loop.
      expect(
        errors.filter((message) => !/import|module|fetch/i.test(message)),
      ).toEqual([]);
    });

  test('a throttled slow network applies every action once, in order', async ({
    page,
    browserName,
  }, testInfo: TestInfo) => {
    const errors = await openLab(page);
    await errorCodes(page);
    const sent: Request[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/increment')) sent.push(request);
    });
    if (browserName === 'chromium') {
      // Real throttling: 400 ms round trips and ~50 KB/s each way.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 400,
        downloadThroughput: 50 * 1024,
        uploadThroughput: 50 * 1024,
      });
    } else {
      // Firefox and WebKit have no throttling protocol: delay each reply.
      await page.route(incrementUrl, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.continue();
      });
    }
    testInfo.annotations.push({
      type: 'network',
      description:
        browserName === 'chromium' ? 'CDP throttling' : 'route delay 400 ms',
    });
    const started = Date.now();
    for (let click = 0; click < 3; click++)
      await page.locator('#increment').click();
    // While requests are slow the component reports that it is busy.
    await expect(page.locator('[data-nv-component]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.locator('#count')).toHaveText('3', { timeout: 20_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 400);
    expect(sent).toHaveLength(3);
    await expect(page.locator('[data-nv-component]')).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await reportedCodes(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** The fault server process: started, stopped and restarted by the tests. */
class FaultServer {
  readonly url: string;
  readonly #port: number;
  readonly #env: NodeJS.ProcessEnv;
  #process: ChildProcess | undefined;
  readonly output: string[] = [];
  /** Exit codes of processes that ended without being stopped by the test. */
  readonly crashes: (number | null)[] = [];

  constructor(port: number, ttlMs: number) {
    this.#port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.#env = {
      ...process.env,
      FAULT_PORT: String(port),
      FAULT_SECRET: randomBytes(32).toString('base64url'),
      FAULT_SESSION_TTL_MS: String(ttlMs),
    };
  }
  async start(): Promise<void> {
    const entry = fileURLToPath(
      new URL('../support/fault-server.ts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      ['--unhandled-rejections=strict', '--import', 'tsx', entry],
      { env: this.#env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.#process = child;
    const collect = (chunk: Buffer) => this.output.push(chunk.toString());
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('exit', (code) => {
      if (this.#process === child) this.crashes.push(code);
    });
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (this.crashes.length)
        throw new Error(`Fault server exited: ${this.output.join('')}`);
      try {
        const response = await fetch(`${this.url}/api/health`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new Error(`Fault server did not start on ${this.#port}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  /** Kill the process (a crash or redeploy, no graceful drain). */
  async kill(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  /** Nothing the server printed may report an unhandled failure. */
  assertClean(): void {
    expect(this.crashes).toEqual([]);
    expect(this.output.join('')).not.toMatch(
      /unhandled|UnhandledPromiseRejection|ERROR \[/i,
    );
  }
}

/** A port per browser project, so parallel projects never share a server. */
function faultPort(testInfo: TestInfo): number {
  const base = Number(process.env['NV_E2E_FAULT_PORT'] ?? 4230);
  const offset = { chromium: 0, firefox: 1, webkit: 2 }[testInfo.project.name];
  return base + (offset ?? 3);
}

async function bootFault(page: Page, url: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url + '/');
  await page.evaluate(async () => {
    await import('/_nestvexa/boot.js' as string);
  });
  return errors;
}

test.describe('fault server restarts and expiry', () => {
  // One fault server port per browser project: never run these in parallel.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);

  test('a backend restart between state updates gives 410, then the reload UX recovers', async ({
    page,
  }, testInfo) => {
    const server = new FaultServer(faultPort(testInfo), 600_000);
    try {
      await server.start();
      const errors = await bootFault(page, server.url);
      await errorCodes(page);
      const { seen } = await captureIncrements(page);
      const firstBoot = await page.locator('#boot').textContent();
      await page.locator('#increment').click();
      await expect(page.locator('#count')).toHaveText('1');

      // The process dies and comes back: the signed identity survives, the
      // in-memory Live state does not.
      await server.kill();
      await server.start();
      await page.locator('#increment').click();
      await expect
        .poll(() => seen.map((reply) => reply.status))
        .toEqual([201, 410]);
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({
        statusCode: 410,
        code: 'INVALID_SNAPSHOT',
      });
      await expect.poll(() => reportedCodes(page)).toEqual(['HTTP']);
      // The client suspends instead of guessing and offers a reload.
      await expect(page.locator('[data-nv-component]')).toHaveAttribute(
        'data-nv-suspended',
        '',
      );
      await expect(page.locator('.reload-hint')).toBeVisible();
      await expect(page.locator('#count')).toHaveText('1');
      // A suspended component sends nothing more.
      await page.locator('#increment').click();
      await page.waitForTimeout(300);
      expect(seen).toHaveLength(2);

      await page.getByRole('link', { name: 'Reload the page' }).click();
      await page.waitForLoadState('load');
      await page.evaluate(async () => {
        await import('/_nestvexa/boot.js' as string);
      });
      await expect(page.locator('#boot')).not.toHaveText(firstBoot ?? '');
      await expect(page.locator('.reload-hint')).toBeHidden();
      await expect(page.locator('#count')).toHaveText('0');
      await page.locator('#increment').click();
      await expect(page.locator('#count')).toHaveText('1');
      expect(errors).toEqual([]);
      server.assertClean();
    } finally {
      await server.kill();
    }
  });

  test('a session that expires while an action is in flight is refused and nothing applies', async ({
    page,
  }, testInfo) => {
    const ttl = 3_000;
    const server = new FaultServer(faultPort(testInfo), ttl);
    try {
      await server.start();
      const loaded = Date.now();
      const errors = await bootFault(page, server.url);
      await errorCodes(page);
      const { seen, holdNext } = await captureIncrements(page);
      await page.locator('#increment').click();
      await expect(page.locator('#count')).toHaveText('1');

      const gate = holdNext();
      await page.locator('#increment').click();
      await gate.reached;
      // Release only after the signed session has expired.
      await page.waitForTimeout(Math.max(0, loaded + ttl + 250 - Date.now()));
      gate.release();
      await expect
        .poll(() => seen.map((reply) => reply.status))
        .toEqual([201, 401]);
      expect(seen[1]?.body ?? '').not.toMatch(/count|snapshot|csrf/i);
      await expect.poll(() => reportedCodes(page)).toEqual(['HTTP']);
      await expect(page.locator('#count')).toHaveText('1');

      // Signing in again recovers with fresh state.
      await page.goto(server.url + '/signin');
      await page.evaluate(async () => {
        await import('/_nestvexa/boot.js' as string);
      });
      await expect(page.locator('#count')).toHaveText('0');
      await page.locator('#increment').click();
      await expect(page.locator('#count')).toHaveText('1');
      expect(errors).toEqual([]);
      server.assertClean();
    } finally {
      await server.kill();
    }
  });
});
