import type { IncomingMessage } from 'node:http';
import type { BrowserContext, Page } from '@playwright/test';
import {
  createOfflineReplayGuard,
  draftScope,
  offlineActionAllowlist,
} from '../packages/offline/dist/server/index.js';
import { startOfflineFixture } from './offline-support.js';
import type { FixtureBrowser, OfflineFixture } from './offline-support.js';

declare global {
  interface Window {
    nvQueueTest: {
      queue: ReturnType<typeof window.nvOffline.createOfflineQueue> | null;
      events: string[];
      errors: string[];
      nativeSubmits: number;
      clock: number | null;
    };
  }
}

export const queueSecret = 'offline-queue-secret-0123456789abcdefghij';
export const aliceScope = draftScope(queueSecret, 'user:alice');
export const bobScope = draftScope(queueSecret, 'user:bob');

/** What the fixture server saw: every arrival, and every real execution. */
export interface QueueServerState {
  identity: string;
  csrf: string;
  /**
   * Responses for the next executions instead of succeeding: a status (`0`
   * proceeds normally) or a status with an error code.
   */
  statuses: (number | { readonly status: number; readonly code: string })[];
  readonly arrivals: {
    readonly method: string;
    readonly path: string;
    readonly key: string | undefined;
    readonly scope: string | undefined;
    readonly csrf: string | undefined;
    readonly status: number;
    readonly outcome: string;
  }[];
  readonly executed: {
    readonly path: string;
    readonly key: string | undefined;
    readonly body: unknown;
  }[];
}
export interface QueueFixture extends OfflineFixture {
  readonly state: QueueServerState;
}

export const queueAllowlist = offlineActionAllowlist([
  { id: 'notes.save', path: '/notes', label: 'Save note', idempotent: true },
  {
    id: 'profile.update',
    path: '/profile',
    method: 'PATCH',
    encoding: 'action',
    label: 'Update profile',
    idempotent: true,
  },
]);

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function formBody(raw: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(raw)) {
    const existing = output[name];
    if (existing === undefined) output[name] = value;
    else
      output[name] = [
        ...(Array.isArray(existing) ? existing : [existing]),
        value,
      ];
  }
  return output;
}

/**
 * Strict-CSP fixture whose `/notes` and `/profile` routes run through a real
 * `createOfflineReplayGuard`, behind a CSRF check, for the current identity.
 * The allowlist meta also carries a hand-written entry without
 * `idempotent: true`, which the browser must ignore.
 */
export async function startQueueFixture(
  body: string,
  browser: FixtureBrowser = 'chromium',
): Promise<QueueFixture> {
  const guard = createOfflineReplayGuard({ allowlist: queueAllowlist });
  const state: QueueServerState = {
    identity: 'user:alice',
    csrf: 'csrf-1',
    statuses: [],
    arrivals: [],
    executed: [],
  };
  const meta = JSON.stringify({
    v: 1,
    actions: [
      ...queueAllowlist.actions,
      { id: 'orders.place', path: '/orders', method: 'POST', encoding: 'form' },
    ],
  }).replaceAll('"', '&quot;');
  const fixture = await startOfflineFixture(
    body,
    {},
    {
      browser,
      head: `<meta name="nv-offline-actions" content="${meta}"><meta name="nestvexa-csrf" content="csrf-1">`,
      async handle(request, response, path) {
        if (request.method === 'GET' || request.method === 'HEAD') return false;
        const raw = await readBody(request);
        const parsed: unknown = (
          header(request, 'content-type') ?? ''
        ).startsWith('application/json')
          ? JSON.parse(raw)
          : formBody(raw);
        const key = header(request, 'idempotency-key');
        const arrival = {
          method: request.method ?? '',
          path,
          key,
          scope: header(request, 'x-nestvexa-offline-scope'),
          csrf: header(request, 'x-nestvexa-csrf'),
        };
        let status: number;
        let payload: unknown;
        let headers: Readonly<Record<string, string>> = {};
        let outcome: string;
        if (arrival.csrf !== state.csrf) {
          status = 403;
          payload = { error: { code: 'CSRF' } };
          outcome = 'csrf';
        } else {
          const result = await guard.run<unknown>(
            {
              method: arrival.method,
              path,
              headers: request.headers,
              scope: draftScope(queueSecret, state.identity),
              body: parsed,
            },
            () => {
              const forced = state.statuses.shift();
              if (typeof forced === 'object')
                return {
                  status: forced.status,
                  body: { error: { code: forced.code } },
                };
              if (forced !== undefined && forced !== 0)
                return { status: forced, body: { error: { code: 'FORCED' } } };
              state.executed.push({ path, key, body: parsed });
              return { status: 201, body: { saved: state.executed.length } };
            },
          );
          status = result.status;
          payload = result.body;
          headers = result.headers;
          outcome = result.outcome;
        }
        state.arrivals.push({ ...arrival, status, outcome });
        response
          .writeHead(status, { 'content-type': 'application/json', ...headers })
          .end(JSON.stringify(payload));
        return true;
      },
    },
  );
  return Object.assign(fixture, { state });
}

/** Queue options that survive structured cloning into the page. */
export interface PageQueueOptions {
  readonly scope?: string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly autoReplay?: boolean;
  readonly retry?: { readonly baseMs?: number; readonly maxMs?: number };
  readonly attach?: boolean;
  readonly clock?: number;
}

/**
 * Open the fixture page and create a queue (plus the status/list controller
 * unless `attach: false`). Native submissions are counted and prevented so a
 * refused form never navigates away; `nvQueueTest.clock` overrides the clock.
 */
export async function openQueuePage(
  fixture: QueueFixture,
  options: PageQueueOptions = {},
  context?: BrowserContext,
): Promise<Page> {
  const page = await fixture.page(context);
  await page.evaluate(
    ({ scope, attach, clock, ...rest }) => {
      const state: Window['nvQueueTest'] = {
        queue: null,
        events: [],
        errors: [],
        nativeSubmits: 0,
        clock: clock ?? null,
      };
      window.nvQueueTest = state;
      document.addEventListener('submit', (event) => {
        if (event.defaultPrevented) return;
        state.nativeSubmits++;
        event.preventDefault();
      });
      const queue = window.nvOffline.createOfflineQueue({
        scope,
        ...rest,
        now: () => state.clock ?? Date.now(),
        onError: (error) =>
          state.errors.push(error instanceof Error ? error.name : 'unknown'),
      });
      state.queue = queue;
      queue.subscribe((event) => state.events.push(event.type));
      if (attach) window.nvOffline.attachOfflineQueue(document, { queue });
    },
    {
      scope: options.scope ?? aliceScope,
      attach: options.attach ?? true,
      clock: options.clock,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.maxEntries === undefined
        ? {}
        : { maxEntries: options.maxEntries }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.autoReplay === undefined
        ? {}
        : { autoReplay: options.autoReplay }),
      retry: options.retry ?? { baseMs: 20, maxMs: 80 },
    },
  );
  return page;
}

/** Raw queue records in local storage, parsed. */
export function storedQueue(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('nv-queue:'))
      .map(
        (key) =>
          JSON.parse(localStorage.getItem(key) ?? 'null') as Record<
            string,
            unknown
          >,
      ),
  );
}
