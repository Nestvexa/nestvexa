import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InertiaModule, InertiaPage } from '../packages/inertia/dist/index.js';
import {
  MemoryInstrumentation,
  currentRequestId,
  requestTracingMiddleware,
  traceGuard,
} from '../packages/observability/dist/index.js';
import {
  RealtimeModule,
  RealtimeService,
} from '../packages/realtime/dist/index.js';
import type {
  RealtimeEvent,
  RealtimeSink,
} from '../packages/realtime/dist/index.js';
import {
  createSsrRenderer,
  viteStaticMiddleware,
} from '../packages/vite/dist/index.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await wait(10);
  if (!check()) throw new Error('condition not reached');
}
async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  cleanup.push(() => app.close());
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

const secret = 'observability-realtime-secret-0123456789ab';
const binding = 'tenant-a/session/realtime-private-binding';
describe('realtime spans', () => {
  it('traces publish, subscribe, connection and delivery with kinds and counts only', async () => {
    const memory = new MemoryInstrumentation();
    const module = await Test.createTestingModule({
      imports: [
        RealtimeModule.forRoot({
          secrets: [secret],
          origin: 'http://127.0.0.1:3488',
          resolveIdentity: (request) => {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              unknown
            >;
            if (headers['x-user'] !== 'alice')
              throw new UnauthorizedException();
            return { binding };
          },
          authorizeChannel: (_identity, channel) =>
            channel.startsWith('orders:'),
          instrumentation: memory,
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    const base = await listen(app);
    const service = app.get(RealtimeService);
    const token =
      (await service.sign({ binding }, ['orders:tenant-secret'])) ?? '';
    // Real SSE subscription through the module (transport attribute "sse").
    const controller = new AbortController();
    const response = await fetch(
      `${base}/_nestvexa/realtime/sse?t=${encodeURIComponent(token)}`,
      { headers: { 'x-user': 'alice' }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    await reader?.read();
    await service.publish('orders:tenant-secret', { total: 'private-total' });
    await until(() =>
      memory.records.some(
        (record) => record.name === 'nestvexa.realtime.deliver',
      ),
    );
    controller.abort();
    await until(() =>
      memory.records.some(
        (record) => record.name === 'nestvexa.realtime.connection',
      ),
    );
    // A direct hub connection with a forged token records the closed code.
    const events: RealtimeEvent[] = [];
    const sink: RealtimeSink = {
      send: (event) => events.push(event) > 0,
      heartbeat: () => undefined,
      close: () => undefined,
    };
    await expect(
      service.hub.connect(
        () => ({ binding }),
        ['forged'],
        sink,
        new Map(),
        'poll',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION' });
    const byName = (name: string) =>
      memory.records.filter((record) => record.name === name);
    expect(byName('nestvexa.realtime.subscribe')).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        attributes: {
          'nestvexa.realtime.transport': 'sse',
          'nestvexa.realtime.tokens': 1,
          'nestvexa.realtime.channels': 1,
        },
      }),
      expect.objectContaining({
        outcome: 'error',
        attributes: {
          'nestvexa.realtime.transport': 'poll',
          'nestvexa.realtime.tokens': 1,
          status: 403,
          'nestvexa.error_code': 'INVALID_SUBSCRIPTION',
        },
      }),
    ]);
    expect(byName('nestvexa.realtime.publish')[0]?.attributes).toEqual({
      'nestvexa.realtime.channel_kind': 'orders',
      'nestvexa.realtime.payload_bytes': JSON.stringify({
        total: 'private-total',
      }).length,
    });
    expect(byName('nestvexa.realtime.deliver')[0]?.attributes).toEqual({
      'nestvexa.realtime.channel_kind': 'orders',
      'nestvexa.realtime.backpressure': false,
    });
    expect(byName('nestvexa.realtime.connection')[0]).toMatchObject({
      outcome: 'ok',
      attributes: {
        'nestvexa.realtime.transport': 'sse',
        'nestvexa.realtime.close_reason': 'client',
      },
    });
    const serialized = JSON.stringify(memory.records);
    for (const value of [
      'tenant-secret',
      'private-total',
      binding,
      token,
      'forged',
    ])
      expect(serialized).not.toContain(value);
  });

  it('rejects an instrumentation without start()', async () => {
    const module = Test.createTestingModule({
      imports: [
        RealtimeModule.forRoot({
          secrets: [secret],
          origin: 'http://127.0.0.1:3488',
          resolveIdentity: () => ({ binding }),
          authorizeChannel: () => true,
          instrumentation: { start: 1 } as never,
        }),
      ],
    });
    await expect(module.compile()).rejects.toThrow(/instrumentation/);
  });
});

describe('asset serving spans', () => {
  it('traces hits, revalidations and misses with type, size and status but no path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-assets-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'app-B9xk2Q_a.js'), 'console.log(1);');
    const memory = new MemoryInstrumentation();
    const middleware = viteStaticMiddleware({
      root,
      prefix: '/build/',
      instrumentation: memory,
    });
    const server: Server = createServer((request, response) =>
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hit = await fetch(`${base}/build/app-B9xk2Q_a.js?secret-query=1`);
    expect(hit.status).toBe(200);
    await hit.text();
    const etag = hit.headers.get('etag') ?? '';
    expect(
      (
        await fetch(`${base}/build/app-B9xk2Q_a.js`, {
          headers: { 'if-none-match': etag },
        })
      ).status,
    ).toBe(304);
    expect((await fetch(`${base}/build/private-missing.js`)).status).toBe(404);
    await until(() => memory.records.length === 3);
    expect(memory.records.map((record) => record.attributes)).toEqual([
      {
        'nestvexa.asset.method': 'GET',
        'nestvexa.asset.hit': true,
        status: 200,
        'nestvexa.asset.type': 'text/javascript; charset=utf-8',
        'nestvexa.asset.bytes': 15,
        'nestvexa.asset.immutable': true,
      },
      {
        'nestvexa.asset.method': 'GET',
        'nestvexa.asset.hit': true,
        status: 304,
        'nestvexa.asset.type': 'text/javascript; charset=utf-8',
        'nestvexa.asset.bytes': 0,
        'nestvexa.asset.immutable': true,
      },
      { 'nestvexa.asset.method': 'GET', 'nestvexa.asset.hit': false },
    ]);
    const serialized = JSON.stringify(memory.records);
    expect(serialized).not.toContain('app-B9xk2Q_a');
    expect(serialized).not.toContain('secret-query');
    expect(serialized).not.toContain('private-missing');
    expect(() =>
      viteStaticMiddleware({ root, instrumentation: {} as never }),
    ).toThrow(/instrumentation/);
  });
});

describe('SSR render spans', () => {
  @Controller()
  class PagesController {
    @Get('report')
    @InertiaPage('Reports/Show')
    report() {
      return { owner: 'private-owner-name' };
    }
  }
  async function ssrApp(
    render: (page: unknown) => unknown,
    memory: MemoryInstrumentation,
  ) {
    const module = await Test.createTestingModule({
      imports: [
        InertiaModule.forRoot({
          version: 'v1',
          instrumentation: memory,
          ssr: {
            renderer: createSsrRenderer({ load: async () => ({ render }) }),
            onError: () => undefined,
          },
        }),
      ],
      controllers: [PagesController],
    }).compile();
    return listen(module.createNestApplication({ logger: false }));
  }

  it('records head/body sizes on success and the closed error type on fallback', async () => {
    const memory = new MemoryInstrumentation();
    const ok = await ssrApp(
      () => ({
        head: ['<title>Report</title>'],
        body: '<h1>private-owner-name</h1>',
      }),
      memory,
    );
    expect((await fetch(`${ok}/report`)).status).toBe(200);
    const failing = await ssrApp(() => {
      throw new Error('private failure detail');
    }, memory);
    const fallback = await fetch(`${failing}/report`);
    expect(fallback.status).toBe(200);
    const ssr = memory.records.filter(
      (record) => record.name === 'nestvexa.ssr.render',
    );
    expect(ssr).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        attributes: {
          'nestvexa.page': 'Reports/Show',
          'nestvexa.inertia.app': 'default',
          'nestvexa.ssr.head_elements': 1,
          'nestvexa.ssr.body_bytes': 27,
        },
      }),
      expect.objectContaining({
        outcome: 'error',
        attributes: {
          'nestvexa.page': 'Reports/Show',
          'nestvexa.inertia.app': 'default',
          'nestvexa.ssr.error_type': 'render',
          'nestvexa.ssr.fallback': true,
        },
      }),
    ]);
    const serialized = JSON.stringify(memory.records);
    expect(serialized).not.toContain('private-owner-name');
    expect(serialized).not.toContain('private failure detail');
  });
});

describe('request admission spans', () => {
  @Controller()
  class EchoController {
    @Get('echo')
    echo() {
      return { requestId: currentRequestId() ?? null };
    }
    @Get('boom')
    boom(): never {
      throw new Error('private boom');
    }
  }
  async function requestApp(
    options: Parameters<typeof requestTracingMiddleware>[1] = {},
  ) {
    const memory = new MemoryInstrumentation();
    const module = await Test.createTestingModule({
      controllers: [EchoController],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.use(requestTracingMiddleware(memory, options));
    return { base: await listen(app), memory };
  }

  it('assigns a request id per request and records method, status and size only', async () => {
    const { base, memory } = await requestApp();
    const response = await fetch(`${base}/echo?private=query`, {
      headers: { 'x-request-id': 'inbound-untrusted-id', cookie: 'sid=secret' },
    });
    const body = (await response.json()) as { requestId: string };
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).toBe(id);
    expect((await fetch(`${base}/boom`)).status).toBe(500);
    await until(() => memory.records.length === 2);
    expect(memory.records[0]).toMatchObject({
      name: 'nestvexa.request',
      outcome: 'ok',
      requestId: id,
      attributes: {
        'nestvexa.http.method': 'GET',
        'nestvexa.http.status': 200,
        'nestvexa.http.response_bytes': expect.any(Number),
      },
    });
    expect(memory.records[1]).toMatchObject({
      outcome: 'error',
      attributes: { 'nestvexa.http.status': 500 },
    });
    const serialized = JSON.stringify(memory.records);
    for (const value of ['private', 'inbound-untrusted-id', 'secret', '/echo'])
      expect(serialized).not.toContain(value);
  });

  it('accepts an inbound request id only when trusted and well-formed', async () => {
    const { base } = await requestApp({
      trustRequestId: (request) =>
        Reflect.get(Reflect.get(request, 'headers') as object, 'x-proxy') ===
        'internal',
    });
    const trusted = await fetch(`${base}/echo`, {
      headers: { 'x-request-id': 'proxy-id-0001', 'x-proxy': 'internal' },
    });
    expect(trusted.headers.get('x-request-id')).toBe('proxy-id-0001');
    for (const value of ['short', 'has spaces in it', 'x'.repeat(65)]) {
      const response = await fetch(`${base}/echo`, {
        headers: { 'x-request-id': value, 'x-proxy': 'internal' },
      });
      expect(response.headers.get('x-request-id')).not.toBe(value);
    }
    const { base: quiet } = await requestApp({
      responseHeader: false,
      trustRequestId: () => {
        throw new Error('policy down');
      },
    });
    const response = await fetch(`${quiet}/echo`);
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(
      ((await response.json()) as { requestId: string }).requestId,
    ).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('guard spans', () => {
  const context = {
    getType: () => 'http',
  } as unknown as ExecutionContext;
  class SessionGuard implements CanActivate {
    constructor(private readonly decision: () => unknown) {}
    canActivate(): boolean {
      const value = this.decision();
      if (value instanceof Error) throw value;
      return value as boolean;
    }
  }

  it('records the guard name and decision and passes results through', async () => {
    const memory = new MemoryInstrumentation();
    expect(
      await traceGuard(new SessionGuard(() => true), memory).canActivate(
        context,
      ),
    ).toBe(true);
    expect(
      await traceGuard(new SessionGuard(() => false), memory).canActivate(
        context,
      ),
    ).toBe(false);
    await expect(
      traceGuard(
        new SessionGuard(() => new ForbiddenException('private reason')),
        memory,
      ).canActivate(context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const observable = {
      canActivate: () => ({
        subscribe(observer: { next(value: unknown): void }) {
          observer.next(true);
          return { unsubscribe: () => undefined };
        },
      }),
    };
    expect(
      await traceGuard(
        observable as unknown as CanActivate,
        memory,
        'StreamGuard',
      ).canActivate(context),
    ).toBe(true);
    expect(memory.records.map((record) => record.attributes)).toEqual([
      {
        'nestvexa.guard': 'SessionGuard',
        'nestvexa.guard.context': 'http',
        'nestvexa.guard.allowed': true,
      },
      {
        'nestvexa.guard': 'SessionGuard',
        'nestvexa.guard.context': 'http',
        'nestvexa.guard.allowed': false,
      },
      {
        'nestvexa.guard': 'SessionGuard',
        'nestvexa.guard.context': 'http',
        'nestvexa.guard.allowed': false,
        status: 403,
      },
      {
        'nestvexa.guard': 'StreamGuard',
        'nestvexa.guard.context': 'http',
        'nestvexa.guard.allowed': true,
      },
    ]);
    expect(JSON.stringify(memory.records)).not.toContain('private reason');
    expect(() =>
      traceGuard(new SessionGuard(() => true), memory, 'bad name'),
    ).toThrow(/Invalid guard span name/);
    expect(() => traceGuard({} as CanActivate, memory)).toThrow(/canActivate/);
  });

  it('works as a global Nest guard', async () => {
    const memory = new MemoryInstrumentation();
    @Controller()
    class OpenController {
      @Get('open')
      open() {
        return 'ok';
      }
    }
    const module = await Test.createTestingModule({
      controllers: [OpenController],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    let allow = true;
    app.useGlobalGuards(traceGuard(new SessionGuard(() => allow), memory));
    const base = await listen(app);
    expect((await fetch(`${base}/open`)).status).toBe(200);
    allow = false;
    expect((await fetch(`${base}/open`)).status).toBe(403);
    expect(
      memory.records.map(
        (record) => record.attributes['nestvexa.guard.allowed'],
      ),
    ).toEqual([true, false]);
  });
});
