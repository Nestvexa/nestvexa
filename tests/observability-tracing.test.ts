import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionError,
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
import { InertiaModule, InertiaPage } from '../packages/inertia/dist/index.js';
import {
  MemoryInstrumentation,
  currentTraceContext,
  describeBudgetWarning,
  formatTraceparent,
  openTelemetryInstrumentation,
  parseTraceState,
  parseTraceparent,
  readTraceContext,
  renderBudgetInstrumentation,
  runWithTraceContext,
  traceContextMiddleware,
} from '../packages/observability/dist/index.js';
import type { BudgetWarning } from '../packages/observability/dist/index.js';
import { UploadsModule } from '../packages/uploads/dist/index.js';
import { PNG, csrfFor, rawUpload } from './support/uploads-http.js';

const apps: INestApplication[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const step of cleanup.splice(0)) await step();
});

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const parentId = '00f067aa0ba902b7';
const valid = `00-${traceId}-${parentId}-01`;

describe('W3C trace context parsing', () => {
  it('accepts well-formed version-00 and future-version headers', () => {
    expect(parseTraceparent(valid)).toEqual({
      traceId,
      parentId,
      sampled: true,
    });
    expect(parseTraceparent(`00-${traceId}-${parentId}-00`)?.sampled).toBe(
      false,
    );
    // Future versions may append fields; only the known prefix is used.
    expect(
      parseTraceparent(`cc-${traceId}-${parentId}-09-extra`)?.sampled,
    ).toBe(true);
  });
  it.each([
    ['uppercase', `00-${traceId.toUpperCase()}-${parentId}-01`],
    ['zero trace id', `00-${'0'.repeat(32)}-${parentId}-01`],
    ['zero parent id', `00-${traceId}-${'0'.repeat(16)}-01`],
    ['version ff', `ff-${traceId}-${parentId}-01`],
    ['version 00 with extra fields', `${valid}-extra`],
    ['short trace id', `00-${traceId.slice(1)}-${parentId}-01`],
    ['injection', `${valid}\r\nx-evil: 1`],
    ['oversized', `${valid}${' '.repeat(600)}`],
    ['empty', ''],
  ])('rejects %s', (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
  it('rejects non-string and duplicate (array) headers', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent([valid, valid])).toBeUndefined();
    expect(
      readTraceContext({ headers: { traceparent: [valid, valid] } }),
    ).toBeUndefined();
  });
  it('drops tracestate unless enabled and validates it when kept', () => {
    const request = {
      headers: { traceparent: valid, tracestate: 'congo=t61rcWkgMzE, rojo=1' },
    };
    expect(readTraceContext(request)?.traceState).toBeUndefined();
    expect(
      readTraceContext(request, { keepTraceState: true })?.traceState,
    ).toBe('congo=t61rcWkgMzE,rojo=1');
    for (const bad of ['no-equals', 'UPPER=1', 'a=b,'.repeat(40), 'a=\u0007'])
      expect(parseTraceState(bad)).toBeUndefined();
  });
  it('applies the trust policy and formats outbound headers', () => {
    expect(
      readTraceContext(
        { headers: { traceparent: valid } },
        { trust: () => false },
      ),
    ).toBeUndefined();
    expect(
      formatTraceparent({ traceId, spanId: 'b7ad6b7169203331', sampled: true }),
    ).toBe(`00-${traceId}-b7ad6b7169203331-01`);
    expect(() =>
      formatTraceparent({ traceId: 'x', spanId: parentId, sampled: false }),
    ).toThrow(/Invalid/);
  });
});

describe('trace context propagation', () => {
  it('scopes the inbound context to the request and survives a throwing trust policy', async () => {
    const middleware = traceContextMiddleware();
    const seen = await new Promise((resolve) =>
      middleware({ headers: { traceparent: valid } }, {}, () => {
        setTimeout(() => resolve(currentTraceContext()?.traceId), 1);
      }),
    );
    expect(seen).toBe(traceId);
    expect(currentTraceContext()).toBeUndefined();
    const throwing = traceContextMiddleware({
      trust: () => {
        throw new Error('policy down');
      },
    });
    let inside: unknown = 'unset';
    throwing({ headers: { traceparent: valid } }, {}, () => {
      inside = currentTraceContext();
    });
    expect(inside).toBeUndefined();
  });
  it('parents OpenTelemetry spans on the inbound context unless a span is already active', () => {
    const started: { name: string; context: unknown }[] = [];
    const tracer = {
      startSpan(name: string, _options?: unknown, context?: unknown) {
        started.push({ name, context });
        return {
          setAttribute: () => undefined,
          setStatus: () => undefined,
          end: () => undefined,
        };
      },
    };
    let active: unknown = undefined;
    const api = {
      context: { active: () => ({ root: true }) },
      trace: {
        setSpanContext: (context: unknown, spanContext: unknown) => ({
          context,
          spanContext,
        }),
        getSpan: () => active,
      },
    };
    const bridge = openTelemetryInstrumentation(tracer, { api });
    runWithTraceContext(parseTraceparent(valid), () =>
      bridge.start('nestvexa.live.render', {}).end('ok'),
    );
    expect(started[0]?.context).toEqual({
      context: { root: true },
      spanContext: {
        traceId,
        spanId: parentId,
        traceFlags: 1,
        isRemote: true,
      },
    });
    active = { span: 'from-http-instrumentation' };
    runWithTraceContext(parseTraceparent(valid), () =>
      bridge.start('nestvexa.live.render', {}).end('ok'),
    );
    expect(started[1]?.context).toBeUndefined();
    bridge.start('outside', {}).end('ok');
    expect(started[2]?.context).toBeUndefined();
  });
  it('records the inbound trace id for devtools correlation', () => {
    const memory = new MemoryInstrumentation();
    runWithTraceContext(parseTraceparent(valid), () =>
      memory.start('nestvexa.action', {}).end('ok'),
    );
    memory.start('nestvexa.action', {}).end('ok');
    expect(memory.records.map((record) => record.traceId)).toEqual([
      traceId,
      undefined,
    ]);
  });
});

describe('render budget warnings', () => {
  function budget(
    extra: Parameters<typeof renderBudgetInstrumentation>[0] = {},
  ) {
    let clock = 0;
    const warnings: BudgetWarning[] = [];
    const inner = new MemoryInstrumentation(500, () => clock);
    const instrumentation = renderBudgetInstrumentation({
      inner,
      environment: 'development',
      now: () => clock,
      onWarning: (warning) => warnings.push(warning),
      ...extra,
    });
    const span = (
      name: string,
      attributes: Record<string, string | number>,
      ms: number,
      end: Record<string, number> = {},
      outcome: 'ok' | 'error' = 'ok',
    ) => {
      const handle = instrumentation.start(name, attributes);
      clock += ms;
      handle.end(outcome, end);
    };
    return {
      warnings,
      inner,
      span,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  }
  it('warns about slow renders, large HTML/state, slow actions and large Inertia pages', () => {
    const f = budget();
    f.span(
      'nestvexa.live.render',
      { 'nestvexa.component': 'table', 'nestvexa.depth': 0 },
      80,
      {
        'nestvexa.html_bytes': 200_000,
        'nestvexa.state_bytes': 40_000,
      },
    );
    f.span(
      'nestvexa.live.action',
      { 'nestvexa.component': 'table', 'nestvexa.action': 'sort' },
      300,
    );
    f.span('nestvexa.action', { 'nestvexa.action': 'add-item' }, 10);
    f.span('nestvexa.inertia.render', { 'nestvexa.page': 'Users/Index' }, 5, {
      'nestvexa.page_bytes': 300_000,
    });
    expect(
      f.warnings.map((warning) => [warning.kind, warning.subject]),
    ).toEqual([
      ['slow-render', 'table'],
      ['large-html', 'table'],
      ['large-state', 'table'],
      ['slow-action', 'table#sort'],
      ['large-page', 'Users/Index'],
    ]);
    expect(describeBudgetWarning(f.warnings[2] as BudgetWarning)).toBe(
      'Nestvexa render budget: large-state in table (nestvexa.live.render): 40000 bytes exceeds 32768 bytes',
    );
    // Spans still reach the wrapped instrumentation unchanged.
    expect(f.inner.records).toHaveLength(4);
  });
  it('detects root render loops, ignores many child renders and deduplicates repeats', () => {
    const f = budget({ maxRendersPerWindow: 3, repeatAfterMs: 5000 });
    for (let index = 0; index < 10; index++)
      f.span(
        'nestvexa.live.render',
        { 'nestvexa.component': 'row', 'nestvexa.depth': 1 },
        1,
      );
    expect(f.warnings).toEqual([]);
    for (let index = 0; index < 6; index++)
      f.span(
        'nestvexa.live.render',
        { 'nestvexa.component': 'poller', 'nestvexa.depth': 0 },
        1,
      );
    expect(f.warnings.map((warning) => warning.kind)).toEqual(['render-loop']);
    f.tick(6000);
    for (let index = 0; index < 4; index++)
      f.span(
        'nestvexa.live.render',
        { 'nestvexa.component': 'poller', 'nestvexa.depth': 0 },
        1,
      );
    expect(f.warnings).toHaveLength(2);
  });
  it('is disabled in production, ignores failed spans and survives a throwing sink', () => {
    const inner = new MemoryInstrumentation();
    expect(
      renderBudgetInstrumentation({ inner, environment: 'production' }),
    ).toBe(inner);
    const f = budget();
    f.span(
      'nestvexa.live.render',
      { 'nestvexa.component': 'x' },
      500,
      {},
      'error',
    );
    expect(f.warnings).toEqual([]);
    const throwing = renderBudgetInstrumentation({
      environment: 'development',
      slowRenderMs: 1,
      now: (() => {
        let clock = 0;
        return () => (clock += 10);
      })(),
      onWarning: () => {
        throw new Error('sink down');
      },
    });
    expect(() =>
      throwing.start('nestvexa.live.render', {}).end('ok'),
    ).not.toThrow();
    expect(() => renderBudgetInstrumentation({ slowRenderMs: -1 })).toThrow(
      /positive/,
    );
  });
});

function get(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${base}${path}`, { headers }, (incoming) => {
      incoming.resume();
      incoming.on('end', () => resolve(incoming.statusCode ?? 0));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<number> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${base}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          ...headers,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolve(incoming.statusCode ?? 0));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(text);
  });
}

describe('structural spans in optional packages', () => {
  it('traces server actions with ids and error codes only, parented on the inbound trace', async () => {
    const memory = new MemoryInstrumentation();
    @Injectable()
    @ActionGroup('cart')
    class CartActions {
      @ServerAction({ id: 'add-item' })
      add(@ActionInput() input: { sku: string }) {
        if (input.sku === 'missing')
          throw ActionError.notFound('No such product');
        return { added: input.sku, secret: 'do-not-trace' };
      }
    }
    const csrf = 'tracing-csrf-token-0123456789abcdef';
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [CartActions],
          origin: 'http://localhost:3300',
          resolveIdentity: () => ({
            subject: 'alice-subject',
            csrfToken: csrf,
          }),
          authorize: () => true,
          instrumentation: memory,
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.use(traceContextMiddleware());
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const headers = {
      origin: 'http://localhost:3300',
      'x-nestvexa-csrf': csrf,
      traceparent: valid,
    };
    expect(
      await post(
        base,
        '/_nestvexa/actions/cart/add-item',
        { input: { sku: 'mug' } },
        headers,
      ),
    ).toBe(200);
    expect(
      await post(
        base,
        '/_nestvexa/actions/cart/add-item',
        { input: { sku: 'missing' } },
        headers,
      ),
    ).toBe(404);
    expect(
      memory.records.map((record) => [
        record.name,
        record.outcome,
        record.attributes,
      ]),
    ).toEqual([
      [
        'nestvexa.action',
        'ok',
        { 'nestvexa.action_group': 'cart', 'nestvexa.action': 'add-item' },
      ],
      [
        'nestvexa.action',
        'error',
        {
          'nestvexa.action_group': 'cart',
          'nestvexa.action': 'add-item',
          'nestvexa.error_code': 'NOT_FOUND',
        },
      ],
    ]);
    expect(memory.records[0]?.traceId).toBe(traceId);
    const serialized = JSON.stringify(memory.records);
    for (const secret of ['do-not-trace', 'alice-subject', csrf, 'mug'])
      expect(serialized).not.toContain(secret);
    expect(() =>
      ActionsModule.register({
        groups: [CartActions],
        origin: 'http://localhost:3300',
        resolveIdentity: () => null,
        authorize: () => true,
        instrumentation: {} as never,
      }),
    ).toThrow(/instrumentation/);
  });

  it('traces Inertia page responses with component, kind and size', async () => {
    const memory = new MemoryInstrumentation();
    @Controller()
    class PagesController {
      @Get('users')
      @InertiaPage('Users/Index')
      users() {
        return { users: ['private-user-name'] };
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        InertiaModule.forRoot({ version: 'v1', instrumentation: memory }),
      ],
      controllers: [PagesController],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    expect(await get(base, '/users')).toBe(200);
    expect(
      await get(base, '/users', {
        'x-inertia': 'true',
        'x-inertia-version': 'v1',
        'x-requested-with': 'XMLHttpRequest',
      }),
    ).toBe(200);
    const records = memory.records.map((record) => record.attributes);
    expect(
      records.map((attributes) => attributes['nestvexa.inertia.kind']),
    ).toEqual(['document', 'json']);
    expect(records[1]?.['nestvexa.page']).toBe('Users/Index');
    expect(records[1]?.['nestvexa.page_bytes']).toBeGreaterThan(10);
    expect(JSON.stringify(memory.records)).not.toContain('private-user-name');
    expect(() =>
      InertiaModule.forRoot({ instrumentation: { start: 1 } as never }),
    ).toThrow(/instrumentation/);
  });

  it('traces uploads with purpose and size but never the file name', async () => {
    const memory = new MemoryInstrumentation();
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-obs-uploads-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    @Module({
      imports: [
        UploadsModule.register({
          origin: 'http://uploads.test',
          directory,
          resolveIdentity(request: object) {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              string | undefined
            >;
            const user = headers['x-test-user'];
            if (!user) throw new UnauthorizedException();
            return {
              binding: `test-user:${user}:binding`,
              csrfToken: csrfFor(user),
            };
          },
          authorize: () => true,
          purposes: { images: { types: ['png'], maxFileSize: 64 * 1024 } },
          instrumentation: memory,
        }),
      ],
    })
    class UploadApp {}
    const module = await Test.createTestingModule({
      imports: [UploadApp],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    expect(
      (await rawUpload(base, 'olga', 'images', 'holiday-secret.png', PNG))
        .status,
    ).toBe(201);
    expect(
      (
        await rawUpload(
          base,
          'olga',
          'images',
          'x.png',
          Buffer.from('not a png'),
        )
      ).status,
    ).toBe(415);
    expect(
      memory.records.map((record) => [record.name, record.outcome]),
    ).toEqual([
      ['nestvexa.upload.receive', 'ok'],
      ['nestvexa.upload.receive', 'error'],
    ]);
    expect(memory.records[0]?.attributes).toEqual({
      'nestvexa.upload.mode': 'direct',
      'nestvexa.upload.purpose': 'images',
      'nestvexa.upload.bytes': PNG.byteLength,
      'nestvexa.upload.files': 1,
    });
    expect(JSON.stringify(memory.records)).not.toContain('holiday-secret');
  });
});
