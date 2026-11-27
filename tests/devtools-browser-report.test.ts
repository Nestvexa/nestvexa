import 'reflect-metadata';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  DEVTOOLS_CLIENT_BATCH_LIMIT,
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  combineInstrumentation,
  openTelemetryInstrumentation,
  requestTracingMiddleware,
  traceContextMiddleware,
} from '../packages/observability/dist/index.js';
import type { DevtoolsSnapshot } from '../packages/observability/dist/index.js';
import { devtoolsReporter } from '../packages/observability/dist/devtools-client.js';
import type { DevtoolsDiagnosticLike } from '../packages/observability/dist/devtools-client.js';

// DX-033 / DX-035: browser timings (morph, network batches) reach the
// development panel through its report endpoint, and a browser `traceparent`
// is joined by the server's spans without ever acting as a credential.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const origin = 'http://localhost:4341';
const csrf = 'report-csrf-token-01234567890123456789012345';
const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spanId = '00f067aa0ba902b7';
const traceparent = `00-${traceId}-${spanId}-01`;

@LiveComponent({ name: 'meter', view: 'meter' })
class Meter {
  @State() count = 0;
  @Action() bump(): void {
    this.count++;
  }
}

@Controller('page')
class PageController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  async page(@Req() request: object): Promise<string> {
    return (await this.live.mount(Meter, request)).value;
  }
}

interface StartedSpan {
  readonly name: string;
  readonly parent: unknown;
}

async function reportApp(options: { readonly inspector?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-report-'));
  await writeFile(join(root, 'meter.hbs'), '<p>{{count}}</p>');
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const memory = new MemoryInstrumentation();
  const inspector = new DevtoolsInspector({ environment: 'test' });
  // A structural OpenTelemetry tracer and API (the bridge's contract).
  const started: StartedSpan[] = [];
  const tracer = {
    startSpan(name: string, _options?: unknown, parent?: unknown) {
      started.push({ name, parent });
      return {
        setAttribute: () => undefined,
        setStatus: () => undefined,
        end: () => undefined,
      };
    },
  };
  const api = {
    context: { active: () => ({ root: true }) },
    trace: {
      setSpanContext: (context: unknown, spanContext: unknown) => ({
        context,
        spanContext,
      }),
    },
  };
  const instrumentation = combineInstrumentation(
    memory,
    openTelemetryInstrumentation(tracer, { api }),
  );
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.registerAsync({
        components: [Meter],
        useFactory: () => ({
          renderer,
          origin,
          resolveIdentity: () => ({
            binding: 'session:report-binding',
            csrfToken: csrf,
          }),
          authorize: () => true,
          instrumentation,
          inspector,
        }),
      }),
      DevtoolsModule.register({
        instrumentation: memory,
        ...(options.inspector === false ? {} : { inspector }),
        authorize: (request) =>
          Reflect.get(Reflect.get(request, 'headers') as object, 'x-dev') ===
          'yes',
        environment: 'test',
      }),
    ],
    controllers: [PageController],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  app.use(traceContextMiddleware());
  app.use(requestTracingMiddleware(memory));
  await app.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await app.close();
    await renderer.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  /** Mount a fresh component and return its snapshot. */
  const mount = async () =>
    /data-nv-snapshot="([^"]+)"/.exec(
      await (await fetch(`${base}/page`)).text(),
    )?.[1] ?? '';
  const snapshot = await mount();
  const post = (
    headers: Record<string, string>,
    token = csrf,
    current = snapshot,
  ) =>
    fetch(`${base}/_nestvexa/live/meter/bump`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': token,
        ...headers,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: current,
        revision: 0,
        updates: {},
        input: null,
      }),
    });
  const host = new URL(base).host;
  const report = (
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${base}/_nestvexa/devtools/client`, {
      method: 'POST',
      headers: {
        'x-dev': 'yes',
        'x-nestvexa-devtools': '1',
        'content-type': 'application/json',
        origin: `http://${host}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const dev = (path = '') =>
    fetch(`${base}/_nestvexa/devtools${path}`, { headers: { 'x-dev': 'yes' } });
  const data = async () =>
    (await (await dev('/data.json')).json()) as DevtoolsSnapshot;
  return { base, mount, post, report, dev, data, memory, started, inspector };
}

const sample = (
  extra: Partial<DevtoolsDiagnosticLike> = {},
): DevtoolsDiagnosticLike => ({
  phase: 'request',
  outcome: 'succeeded',
  milliseconds: 12.34,
  component: 'meter',
  requestBytes: 180,
  responseBytes: 420,
  traceId,
  ...extra,
});

describe('browser trace context', { timeout: 60_000 }, () => {
  it('joins the browser trace in Live spans and the OpenTelemetry bridge', async () => {
    const f = await reportApp();
    const response = await f.post({ traceparent });
    expect(response.status).toBe(201);
    // The inbound header is correlation data only and is never echoed.
    for (const [name, value] of response.headers) {
      expect(name).not.toBe('traceparent');
      expect(value).not.toContain(traceId);
    }
    const action = f.memory.records.find(
      (record) => record.name === 'nestvexa.live.action',
    );
    expect(action?.traceId).toBe(traceId);
    const bridged = f.started.find(
      (span) => span.name === 'nestvexa.live.action',
    );
    expect(bridged?.parent).toEqual({
      context: { root: true },
      spanContext: { traceId, spanId, traceFlags: 1, isRemote: true },
    });
    const data = await f.data();
    expect(
      data.actions.find((record) => record.name === 'nestvexa.live.action')
        ?.traceId,
    ).toBe(traceId);
  });

  it('never treats a traceparent as authorization and ignores malformed ones', async () => {
    const f = await reportApp();
    // A valid trace context does not replace the CSRF token or the identity.
    const forged = await f.post(
      { traceparent },
      'forged-token-012345678901234567890123',
    );
    expect(forged.status).toBe(403);
    const rejected = f.memory.records.find(
      (record) => record.name === 'nestvexa.live.admit',
    );
    expect(rejected).toMatchObject({
      outcome: 'error',
      traceId,
      attributes: { 'nestvexa.error_code': 'CSRF_REJECTED' },
    });
    expect(
      f.memory.records.some((record) => record.name === 'nestvexa.live.action'),
    ).toBe(false);
    // Malformed or all-zero contexts start a new trace instead.
    for (const value of [
      `00-${'0'.repeat(32)}-${spanId}-01`,
      `ff-${traceId}-${spanId}-01`,
      `00-${traceId.toUpperCase()}-${spanId}-01`,
      'not-a-traceparent',
    ]) {
      const fresh = await f.mount();
      f.memory.clear();
      f.started.length = 0;
      expect((await f.post({ traceparent: value }, csrf, fresh)).status).toBe(
        201,
      );
      expect(
        f.memory.records.every((record) => record.traceId === undefined),
        value,
      ).toBe(true);
      expect(
        f.started.every((span) => span.parent === undefined),
        value,
      ).toBe(true);
    }
  });
});

describe(
  'browser timings in the development panel',
  { timeout: 60_000 },
  () => {
    it('shows browser morph timing and network batches per component', async () => {
      const f = await reportApp();
      const response = await f.report({
        timings: [
          sample(),
          sample({ milliseconds: 30, requestBytes: 200, responseBytes: 600 }),
          sample({ phase: 'morph', milliseconds: 4 }),
          sample({ phase: 'morph', milliseconds: 9 }),
          sample({ phase: 'queue', milliseconds: 1 }),
          sample({ outcome: 'failed', milliseconds: 5, responseBytes: 0 }),
        ],
      });
      expect(response.status).toBe(204);
      const data = await f.data();
      expect(data.browser.network).toEqual([
        {
          component: 'meter',
          requests: 3,
          failed: 1,
          requestBytes: 560,
          responseBytes: 1020,
          averageMs: 15.8,
          maxMs: 30,
        },
      ]);
      expect(data.browser.morphs).toEqual([
        { component: 'meter', morphs: 2, p50: 9, max: 9 },
      ]);
      expect(data.browser.timings[0]).toMatchObject({
        phase: 'request',
        outcome: 'failed',
        component: 'meter',
        traceId,
      });
      const html = await (await f.dev()).text();
      expect(html).toContain('Browser morph timing');
      expect(html).toContain('Network batches');
      expect(html).toContain(`<code>${traceId}</code>`);
      expect(html).toContain('<td>560</td><td>1020</td>');
    });

    it('keeps only the closed timing shape and drops everything else', async () => {
      const f = await reportApp();
      const response = await f.report({
        timings: [
          {
            ...sample(),
            state: { apiToken: 'tok-secret-in-report' },
            url: '/account?token=tok-secret-in-url',
          },
          sample({ component: '<script>alert(1)</script>' }),
          sample({ traceId: 'TOK-not-a-trace-id' }),
          sample({ requestBytes: -1, responseBytes: 1.5 }),
          { phase: 'paint', outcome: 'succeeded', milliseconds: 1 },
          { phase: 'morph', outcome: 'won', milliseconds: 1 },
          { phase: 'morph', outcome: 'succeeded', milliseconds: -1 },
          { phase: 'morph', outcome: 'succeeded', milliseconds: 'slow' },
          'not an object',
          null,
        ],
      });
      expect(response.status).toBe(204);
      const data = await f.data();
      expect(data.browser.timings).toHaveLength(4);
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('tok-secret');
      expect(serialized).not.toContain('<script>');
      expect(serialized).not.toContain('TOK-not');
      for (const timing of data.browser.timings)
        expect(Object.keys(timing).sort()).toEqual(
          expect.arrayContaining(['at', 'milliseconds', 'outcome', 'phase']),
        );
      expect(data.browser.timings.filter((timing) => timing.component)).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ component: '<script>alert(1)</script>' }),
        ]),
      );
      const bad = data.browser.timings.find(
        (timing) => timing.requestBytes === undefined && timing.component,
      );
      expect(bad?.responseBytes).toBeUndefined();
    });

    it('refuses reports that are cross-site, not JSON, unauthorized, oversized or without an inspector', async () => {
      const f = await reportApp();
      const body = { timings: [sample()] };
      expect(
        (await f.report(body, { 'x-nestvexa-devtools': '0' })).status,
      ).toBe(403);
      expect(
        (await f.report(body, { origin: 'https://attacker.example' })).status,
      ).toBe(403);
      expect((await f.report(body, { origin: 'null' })).status).toBe(403);
      expect(
        (await f.report(body, { 'sec-fetch-site': 'cross-site' })).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${f.base}/_nestvexa/devtools/client`, {
            method: 'POST',
            headers: {
              'x-dev': 'yes',
              'x-nestvexa-devtools': '1',
              'content-type': 'text/plain',
            },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403);
      expect((await f.report(body, { 'x-dev': 'no' })).status).toBe(403);
      expect(
        (
          await f.report({
            timings: Array.from(
              { length: DEVTOOLS_CLIENT_BATCH_LIMIT + 1 },
              () => sample(),
            ),
          })
        ).status,
      ).toBe(400);
      expect((await f.report({ timings: 'many' })).status).toBe(400);
      expect((await f.report([sample()])).status).toBe(400);
      expect((await f.data()).browser.timings).toEqual([]);

      const bare = await reportApp({ inspector: false });
      expect((await bare.report(body)).status).toBe(404);
    });

    it('answers 404 once the process is switched to production', async () => {
      const root = await mkdtemp(join(tmpdir(), 'nestvexa-report-prod-'));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const inspector = new DevtoolsInspector({ environment: 'test' });
      const module = await Test.createTestingModule({
        imports: [
          DevtoolsModule.register({
            instrumentation: new MemoryInstrumentation(),
            inspector,
            authorize: () => true,
          }),
        ],
      }).compile();
      const app = module.createNestApplication({ logger: false });
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const response = await fetch(`${base}/_nestvexa/devtools/client`, {
          method: 'POST',
          headers: {
            'x-nestvexa-devtools': '1',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ timings: [sample()] }),
        });
        expect(response.status).toBe(404);
      } finally {
        process.env['NODE_ENV'] = previous;
      }
      expect(inspector.clientTimings).toEqual([]);
    });
  },
);

describe('devtoolsReporter (browser half)', { timeout: 60_000 }, () => {
  it('batches Live client diagnostics to the panel endpoint', async () => {
    const f = await reportApp();
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const reporter = devtoolsReporter({
      flushMs: 5,
      fetch: (url, init) => {
        sent.push({ url: String(url), init });
        const headers = new Headers(init?.headers);
        headers.set('x-dev', 'yes');
        return fetch(`${f.base}${String(url)}`, { ...init, headers });
      },
    });
    for (let index = 0; index < 60; index++)
      reporter.onDiagnostic({
        ...sample({ milliseconds: index }),
        // A host passing richer objects never leaks extra fields.
        ...({ state: 'tok-secret-extra' } as object),
      });
    await reporter.flush();
    expect(sent.map(({ url }) => url)).toEqual([
      '/_nestvexa/devtools/client',
      '/_nestvexa/devtools/client',
    ]);
    const first = sent[0]?.init;
    expect(first?.method).toBe('POST');
    expect(first?.credentials).toBe('same-origin');
    expect(new Headers(first?.headers).get('x-nestvexa-devtools')).toBe('1');
    const payload = JSON.parse(String(first?.body)) as {
      timings: Record<string, unknown>[];
    };
    expect(payload.timings).toHaveLength(DEVTOOLS_CLIENT_BATCH_LIMIT);
    expect(String(first?.body)).not.toContain('tok-secret');
    expect((await f.data()).browser.network[0]?.requests).toBe(60);
    reporter.dispose();
    reporter.onDiagnostic(sample());
    await reporter.flush();
    expect(sent).toHaveLength(2);
  });

  it('bounds its buffer, survives a failing transport and validates options', async () => {
    let calls = 0;
    const reporter = devtoolsReporter({
      flushMs: 60_000,
      fetch: () => {
        calls++;
        return Promise.reject(new Error('offline'));
      },
    });
    for (let index = 0; index < 500; index++) reporter.onDiagnostic(sample());
    await expect(reporter.flush()).resolves.toBeUndefined();
    // 200 buffered timings at most, sent as batches of 50.
    expect(calls).toBe(4);
    reporter.dispose();
    for (const endpoint of [
      'https://attacker.example/collect',
      '//attacker.example/collect',
      'relative/path',
      '/path?query=1',
    ])
      expect(() => devtoolsReporter({ endpoint }), endpoint).toThrow(
        /same-origin path/,
      );
    for (const flushMs of [0, -1, 1.5, 60_001])
      expect(() => devtoolsReporter({ flushMs }), String(flushMs)).toThrow(
        /flushMs/,
      );
  });
});
