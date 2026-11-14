/**
 * Real-Chromium harness for directive combination tables. The canonical bundled
 * client (`packages/client/dist/index.js`) runs unmodified; only `fetch` is a
 * deterministic in-page fake Live server so rows can hold, fail or reorder
 * responses. Server-protocol conformance is covered by the Nest suites.
 */
import { chromium, expect, firefox, webkit } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { OutgoingHttpHeaders, Server } from 'node:http';
import { readFile } from 'node:fs/promises';

/** What the fake server does for one action name (`_sync` for model synchronization). */
export interface ActionSpec {
  readonly increment?: string;
  readonly toggle?: string;
  readonly copy?: readonly [from: string, to: string];
  readonly set?: Readonly<Record<string, unknown>>;
  /** Reply with this HTTP status and an empty JSON body. */
  readonly status?: number;
  /** Reject `fetch` like a dropped connection. */
  readonly network?: true;
  /** Never settle; the client deadline must end the request. */
  readonly never?: true;
  /** Reply with a structurally invalid envelope. */
  readonly malformed?: true;
  /** Reply for the current revision instead of the next one. */
  readonly stale?: true;
  /** Hold the reply until `release()`. */
  readonly hold?: true;
  /**
   * Fail the first `times` calls with a dropped connection or an HTTP status.
   * With `commit`, the first failure happens after the state change (a lost
   * reply); an identical retry (same requestId) then gets the stored reply,
   * like an idempotent server action.
   */
  readonly fail?: {
    readonly times: number;
    readonly with: 'network' | number;
    readonly commit?: true;
  };
  /** Advertise this protocol major in the x-nestvexa-protocol reply header. */
  readonly protocol?: string;
}
export interface MatrixComponent {
  /** Inner template: `{{field}}` (escaped), `{{#field}}…{{/field}}`, `{{^field}}…{{/field}}`. */
  readonly html: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly actions?: Readonly<Record<string, ActionSpec>>;
  /** Hold every reply until `release()`. */
  readonly hold?: boolean;
  readonly requestTimeoutMs?: number;
  /** Custom confirmation answer; omitted uses the native dialog. */
  readonly confirm?: 'approve' | 'deny';
  /** Use the default `nestvexa:error` DOM event path instead of `onError`. */
  readonly domErrors?: boolean;
  /** Extra attributes for the component root, e.g. a scroll container class. */
  readonly rootClass?: string;
  /**
   * Emulate browser form restoration before mount: selector → restored value
   * (string) or checkedness (boolean); option selectors toggle `selected`.
   */
  readonly restore?: Readonly<Record<string, string | boolean>>;
  /** Create the client with `development: true`. */
  readonly development?: boolean;
  /** Server-declared idempotent actions (the data-nv-idempotent marker). */
  readonly idempotent?: readonly string[];
}
export interface MatrixRequest {
  readonly action: string;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly input: unknown;
  readonly requestId: string;
}
export interface MatrixSnapshot {
  readonly requests: readonly MatrixRequest[];
  readonly errors: readonly string[];
  readonly events: readonly string[];
  readonly pending: number;
}

declare global {
  interface Window {
    nvMatrixClient: typeof import('../../packages/client/dist/index.js');
    nvHarness: {
      readonly client: import('../../packages/client/dist/index.js').LiveClient;
      readonly root: HTMLElement;
      readonly state: Record<string, unknown>;
      readonly requests: MatrixRequest[];
      readonly errors: string[];
      readonly events: string[];
      readonly pending: (() => void)[];
      release(index?: number): void;
      render(): string;
    };
  }
}

const css =
  '[nv\\:cloak]{display:none}.scroller{height:120px;overflow:auto}.tall{height:2400px}.spacer{height:1600px}';

export interface MatrixFixture {
  readonly browser: Browser;
  readonly engine: MatrixBrowser;
  readonly base: string;
  /** Respond to `/` with this extra header set (for CSP rows). */
  headers: OutgoingHttpHeaders;
  close(): Promise<void>;
}

export type MatrixBrowser = 'chromium' | 'firefox' | 'webkit';
/** Browsers for matrix suites; `NESTVEXA_MATRIX_BROWSERS=chromium` narrows a local run. */
export const matrixBrowsers: readonly MatrixBrowser[] = (
  process.env['NESTVEXA_MATRIX_BROWSERS'] ?? 'chromium,firefox,webkit'
)
  .split(',')
  .filter(
    (name): name is MatrixBrowser =>
      name === 'chromium' || name === 'firefox' || name === 'webkit',
  );

export async function startMatrix(
  engine: MatrixBrowser = 'chromium',
): Promise<MatrixFixture> {
  const bundle = new URL(
    '../../packages/client/dist/index.js',
    import.meta.url,
  );
  const fixture: { headers: OutgoingHttpHeaders } = { headers: {} };
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/' || path === '/other') {
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          ...fixture.headers,
        })
        .end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Directive matrix</title><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></head><body><main id="host"></main><a id="other" href="/other">Other</a></body></html>',
        );
      return;
    }
    if (path === '/fixture.css') {
      response.writeHead(200, { 'content-type': 'text/css' }).end(css);
      return;
    }
    if (path === '/fixture.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        .end(
          "import * as client from '/index.js'; window.nvMatrixClient = client;",
        );
      return;
    }
    // The canonical entry and its on-demand feature chunks (ADR 0036), served
    // side by side as nestvexa/assets does.
    if (path === '/index.js' || /^\/live-[a-z]+\.js$/.test(path)) {
      void readFile(new URL(`.${path}`, bundle), 'utf8').then(
        (source) =>
          response
            .writeHead(200, {
              'content-type': 'text/javascript; charset=utf-8',
            })
            .end(source),
        () => response.writeHead(404).end(),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing matrix fixture port');
  const browser = await { chromium, firefox, webkit }[engine].launch();
  return {
    browser,
    engine,
    base: `http://127.0.0.1:${address.port}`,
    get headers() {
      return fixture.headers;
    },
    set headers(value: OutgoingHttpHeaders) {
      fixture.headers = value;
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export async function openPage(fixture: MatrixFixture): Promise<Page> {
  const page = await fixture.browser.newPage();
  await page.goto(fixture.base);
  await page.waitForFunction(() => Reflect.has(window, 'nvMatrixClient'));
  return page;
}

/** Install the fake server, render the component and mount one client. */
export async function mountMatrix(
  page: Page,
  component: MatrixComponent,
): Promise<void> {
  await page.evaluate((config) => {
    const host = document.getElementById('host');
    if (!host) throw new Error('Missing matrix host');
    host.replaceChildren();
    const state: Record<string, unknown> = structuredClone(config.state);
    const escape = (value: string): string =>
      value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    const lookup = (path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>(
          (value, key) =>
            value && typeof value === 'object'
              ? Reflect.get(value, key)
              : undefined,
          state,
        );
    const render = (): string =>
      config.html
        .replace(
          /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
          (_match, kind: string, field: string, body: string) =>
            Boolean(lookup(field)) === (kind === '#') ? body : '',
        )
        .replace(/\{\{([\w.]+)\}\}/g, (_match, field: string) => {
          const value = lookup(field);
          return escape(
            typeof value === 'string'
              ? value
              : value === undefined || value === null
                ? ''
                : JSON.stringify(value),
          );
        });
    const root = document.createElement('div');
    const markers: Record<string, string> = {
      'data-nv-component': '11111111-1111-4111-8111-111111111111',
      'data-nv-name': 'matrix',
      'data-nv-snapshot': 'A'.repeat(43),
      'data-nv-state': JSON.stringify(state),
      'data-nv-revision': '0',
      'data-nv-endpoint': '/live/matrix',
      'data-nv-csrf': 'matrix-csrf-0123456789012345678901234567',
    };
    for (const [name, value] of Object.entries(markers))
      root.setAttribute(name, value);
    if (config.idempotent)
      root.setAttribute(
        'data-nv-idempotent',
        JSON.stringify(config.idempotent),
      );
    if (config.rootClass) root.className = config.rootClass;
    root.innerHTML = render();
    host.append(root);
    const requests: MatrixRequest[] = [];
    const errors: string[] = [];
    const events: string[] = [];
    const pending: (() => void)[] = [];
    for (const name of [
      'nestvexa:updated',
      'nestvexa:error',
      'nestvexa:rollback',
      'nestvexa:before-remove',
      'nestvexa:after-insert',
      'nestvexa:request',
      'nestvexa:restored',
    ])
      document.addEventListener(name, (event) => {
        const detail: unknown = (event as CustomEvent).detail;
        events.push(
          name === 'nestvexa:error' ||
            name === 'nestvexa:request' ||
            name === 'nestvexa:restored'
            ? `${name}:${JSON.stringify(detail)}`
            : name,
        );
      });
    const calls = new Map<string, number>();
    const replies = new Map<string, Response>();
    const json = (body: unknown, status = 200, protocol?: string): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          ...(protocol === undefined
            ? {}
            : { 'x-nestvexa-protocol': protocol }),
        },
      });
    const client = window.nvMatrixClient.createLiveClient({
      ...(config.development ? { development: true } : {}),
      ...(config.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.requestTimeoutMs }),
      ...(config.confirm === undefined
        ? {}
        : { confirm: () => config.confirm === 'approve' }),
      ...(config.domErrors
        ? {}
        : {
            onError(error: Error) {
              errors.push(String(Reflect.get(error, 'code') ?? error.name));
            },
          }),
      fetch(url, init) {
        const action = String(url).split('/').at(-1) ?? '';
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
          revision: number;
          snapshot: string;
          updates: Record<string, unknown>;
          input: unknown;
        };
        requests.push({
          action,
          updates: body.updates,
          input: body.input,
          requestId: body.requestId,
        });
        const spec = config.actions?.[action] ?? {};
        const replayed = replies.get(body.requestId);
        if (replayed) return Promise.resolve(replayed.clone());
        const call = (calls.get(action) ?? 0) + 1;
        calls.set(action, call);
        const failure =
          spec.fail && call <= spec.fail.times ? spec.fail : undefined;
        if (failure && !(failure.commit && call === 1))
          return failure.with === 'network'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(json({}, failure.with));
        if (spec.network)
          return Promise.reject(new TypeError('Failed to fetch'));
        if (spec.never) return new Promise<Response>(() => undefined);
        const reply = (): Response => {
          if (spec.status) return json({}, spec.status);
          if (spec.malformed) return json({ protocol: 'other' });
          Object.assign(state, body.updates);
          if (spec.increment)
            state[spec.increment] = Number(state[spec.increment]) + 1;
          if (spec.toggle) state[spec.toggle] = !state[spec.toggle];
          if (spec.copy) state[spec.copy[1]] = state[spec.copy[0]];
          if (spec.set) Object.assign(state, structuredClone(spec.set));
          return json(
            {
              protocol: 'nestvexa-live/1',
              requestId: body.requestId,
              component: {
                id: markers['data-nv-component'],
                name: 'matrix',
                revision: body.revision + (spec.stale ? 0 : 1),
              },
              snapshot: body.snapshot,
              state,
              html: render(),
            },
            200,
            spec.protocol,
          );
        };
        if (failure) {
          // A committed change whose reply is lost; the identical retry replays it.
          replies.set(body.requestId, reply());
          return failure.with === 'network'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(json({}, failure.with));
        }
        if (!config.hold && !spec.hold) return Promise.resolve(reply());
        return new Promise<Response>((resolve) =>
          pending.push(() => resolve(reply())),
        );
      },
    });
    window.nvHarness = {
      client,
      root,
      state,
      requests,
      errors,
      events,
      pending,
      release(index = 0) {
        const settle = pending[index];
        if (!settle) throw new Error('No held matrix request');
        pending.splice(index, 1);
        settle();
      },
      render,
    };
    for (const [selector, value] of Object.entries(config.restore ?? {})) {
      const control = root.querySelector(selector);
      if (control instanceof HTMLOptionElement && typeof value === 'boolean')
        control.selected = value;
      else if (
        control instanceof HTMLInputElement &&
        typeof value === 'boolean'
      )
        control.checked = value;
      else if (
        (control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement) &&
        typeof value === 'string'
      )
        control.value = value;
      else throw new Error(`Cannot restore ${selector}`);
    }
    client.mount();
  }, component);
}

export function snapshot(page: Page): Promise<MatrixSnapshot> {
  return page.evaluate(() => ({
    requests: structuredClone(window.nvHarness.requests),
    errors: [...window.nvHarness.errors],
    events: [...window.nvHarness.events],
    pending: window.nvHarness.pending.length,
  }));
}

export async function actions(page: Page): Promise<string[]> {
  return (await snapshot(page)).requests.map((request) => request.action);
}

/** Wait until the fake server has received exactly these actions, in order. */
export async function expectActions(
  page: Page,
  expected: readonly string[],
): Promise<void> {
  await expect.poll(() => actions(page), { timeout: 5000 }).toEqual(expected);
}

/** Release every held reply, including replies queued by the released ones. */
export async function releaseAll(page: Page): Promise<void> {
  for (let round = 0; round < 32; round++) {
    const remaining = await page.evaluate(() => {
      if (window.nvHarness.pending.length) window.nvHarness.release(0);
      return window.nvHarness.pending.length;
    });
    // Let the client commit and dispatch any queued follow-up request.
    await page.waitForTimeout(20);
    if (
      remaining === 0 &&
      (await page.evaluate(() => window.nvHarness.pending.length)) === 0
    )
      return;
  }
}
