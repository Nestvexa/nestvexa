/**
 * Slow clients against the Nestvexa request surface (SEC-004): slowloris,
 * slow request heads and trickled bodies over raw sockets, on Express and
 * Fastify, against the Live action and `$sync` routes, server actions and
 * Inertia routes. `configureNestvexa` bounds the host's Node server
 * (`boundHttpServer` in @nestvexa/core); these tests use short bounds and
 * prove that a slow client is answered with 408 and disconnected in time,
 * that its handler never runs, that other clients are served meanwhile, and
 * that the server holds no connection afterwards. Stalled multipart uploads
 * are covered by the uploads idle timeout in tests/uploads-http.test.ts.
 */
import 'reflect-metadata';
import { Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, Server as HttpServer } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  boundHttpServer,
  configureNestvexa,
  normalizeHttpServerBounds,
} from '../packages/nestvexa/dist/index.js';
import {
  ActionGroup,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
import {
  InertiaModule,
  InertiaPage,
  InertiaSecurityGuard,
} from '../packages/inertia/dist/index.js';
import './support/no-unhandled-rejections.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const origin = 'http://127.0.0.1:4330';
const csrf = 'slow-clients-csrf-0123456789abcdefghijklmnop';
const xsrf = 'slow-clients-xsrf-0123456789';
const bounds = { headersTimeoutMs: 1_000, requestTimeoutMs: 1_500 } as const;
const executions: string[] = [];

@LiveComponent({ name: 'slow-probe', view: 'slow-probe' })
class SlowProbe {
  @State() count = 0;
  @Action() increment(): void {
    executions.push('live');
    this.count++;
  }
}

@ActionGroup('slow')
class SlowActions {
  @ServerAction({ id: 'touch' })
  touch() {
    executions.push('action');
    return { touched: true };
  }
}

@Controller('inertia')
@UseGuards(InertiaSecurityGuard)
class InertiaPages {
  @Get('dashboard')
  @InertiaPage('Dashboard')
  dashboard() {
    return { greeting: 'hello' };
  }
  @Post('save')
  save() {
    executions.push('inertia');
    return { saved: true };
  }
}

@Controller()
class Health {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-slow-clients-'));
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()))
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function start(
  platform: 'express' | 'fastify',
  http: Parameters<typeof configureNestvexa>[1] = { http: bounds },
) {
  executions.length = 0;
  const root = await temporary();
  await writeFile(join(root, 'slow-probe.hbs'), '<p>{{count}}</p>');
  const identity = { binding: 'slow-clients/session', csrfToken: csrf };
  @Module({
    imports: [
      NestvexaModule.forRoot(
        { views: { root }, live: { enabled: true } },
        {
          components: [SlowProbe],
          useFactory: () => ({
            origin,
            maxRequestsPerMinute: 10_000,
            resolveIdentity: () => identity,
            authorize: () => true,
          }),
        },
      ),
      ActionsModule.register({
        groups: [SlowActions],
        origin,
        resolveIdentity: () => ({ subject: 'slow', csrfToken: csrf }),
        authorize: () => true,
      }),
      InertiaModule.forRoot({
        security: { origin, csrfToken: () => xsrf, authorize: () => true },
      }),
    ],
    controllers: [InertiaPages, Health],
  })
  class AppModule {}
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await configureNestvexa(app, http);
  await app.listen(0, '127.0.0.1');
  cleanup.push(() => app.close());
  const server: unknown = app.getHttpServer();
  if (!(server instanceof HttpServer)) throw new Error('No Node HTTP server');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(
    (await app.get(LiveRuntime).mount(SlowProbe, { headers: {} })).value,
  )?.[1];
  if (!snapshot) throw new Error('No snapshot');
  const liveBody = (requestId = randomUUID()) =>
    JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId,
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    });
  return { app, server, port: address.port, liveBody };
}

/** The four request kinds under test: method, path, headers and a valid body. */
function targets(liveBody: () => string) {
  const json = { 'content-type': 'application/json', origin };
  return [
    {
      name: 'Live action',
      path: '/_nestvexa/live/slow-probe/increment',
      headers: { ...json, 'x-nestvexa-csrf': csrf },
      body: liveBody,
    },
    {
      name: 'Live $sync',
      path: '/_nestvexa/live/slow-probe/$sync',
      headers: { ...json, 'x-nestvexa-csrf': csrf },
      body: liveBody,
    },
    {
      name: 'server action',
      path: '/_nestvexa/actions/slow/touch',
      headers: { ...json, 'x-nestvexa-csrf': csrf },
      body: () => '{}',
    },
    {
      name: 'Inertia route',
      path: '/inertia/save',
      // A host POST route behind the Inertia security guard.
      headers: { ...json, 'x-xsrf-token': xsrf },
      body: () => '{}',
    },
  ] as const;
}

function head(
  path: string,
  headers: Readonly<Record<string, string>>,
  length: number,
): string {
  return (
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
    Object.entries({ ...headers, 'content-length': String(length) })
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('') +
    '\r\n'
  );
}

/** A raw client that records what the server sends and when it closes. */
function client(port: number) {
  const socket: Socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  let received = '';
  let closedAt: number | undefined;
  const opened = performance.now();
  socket.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
  const closed = new Promise<number>((done) =>
    socket.once('close', () => {
      closedAt = performance.now() - opened;
      done(closedAt);
    }),
  );
  cleanup.push(() => {
    socket.destroy();
  });
  return {
    socket,
    closed,
    received: () => received,
    isClosed: () => closedAt !== undefined,
    /** Write `text` one byte every `everyMs` until it is sent or the server hangs up. */
    async trickle(text: string, everyMs: number) {
      for (const byte of text) {
        if (closedAt !== undefined || socket.destroyed) return;
        socket.write(byte);
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    },
  };
}

async function connections(server: HttpServer): Promise<number> {
  return new Promise((done, fail) =>
    server.getConnections((error, count) =>
      error ? fail(error) : done(count),
    ),
  );
}

describe.each(['express', 'fastify'] as const)(
  'slow clients on %s',
  (platform) => {
    it('closes a request head trickled past headersTimeoutMs with 408, on every route', async () => {
      const f = await start(platform);
      const clients = targets(f.liveBody).map((target) => {
        const c = client(f.port);
        const body = target.body();
        // A byte every 100 ms: each write is fresh activity, so only a bound
        // on the whole head (not an idle timeout) can stop it.
        void c.trickle(
          head(target.path, target.headers, Buffer.byteLength(body)) + body,
          100,
        );
        return { target, c };
      });
      for (const { target, c } of clients) {
        const elapsed = await c.closed;
        expect(elapsed, target.name).toBeGreaterThanOrEqual(900);
        expect(elapsed, target.name).toBeLessThan(3_500);
        expect(c.received(), target.name).toMatch(/^HTTP\/1\.1 408 /);
      }
      expect(executions).toEqual([]);
      expect(await connections(f.server)).toBe(0);
    }, 30_000);

    it('closes a body trickled past requestTimeoutMs with 408 before any handler runs', async () => {
      const f = await start(platform);
      const clients = targets(f.liveBody).map((target) => {
        const c = client(f.port);
        const body = target.body();
        // The complete head at once, then the body a byte every 100 ms: the
        // body (dozens of bytes or more) would take longer than the bound.
        c.socket.write(
          head(target.path, target.headers, Buffer.byteLength(body) + 64),
        );
        void c.trickle(body + ' '.repeat(64), 100);
        return { target, c };
      });
      for (const { target, c } of clients) {
        const elapsed = await c.closed;
        expect(elapsed, target.name).toBeGreaterThanOrEqual(1_400);
        expect(elapsed, target.name).toBeLessThan(4_000);
        expect(c.received(), target.name).toMatch(/^HTTP\/1\.1 408 /);
      }
      // No route ever saw a complete body, so no handler ran.
      expect(executions).toEqual([]);
      expect(await connections(f.server)).toBe(0);
    }, 30_000);

    it('serves a slow but bounded request normally', async () => {
      const f = await start(platform);
      const [live, , action, inertia] = targets(f.liveBody);
      for (const target of [live, action, inertia]) {
        const c = client(f.port);
        const body = target.body();
        c.socket.write(
          head(target.path, target.headers, Buffer.byteLength(body)),
        );
        // Half the body, a pause well under the bound, then the rest.
        const half = Math.floor(body.length / 2);
        c.socket.write(body.slice(0, half));
        await new Promise((resolve) => setTimeout(resolve, 500));
        c.socket.write(body.slice(half));
        const end = Date.now() + 5_000;
        while (!/\r\n\r\n/.test(c.received()) && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(c.received(), target.name).toMatch(/^HTTP\/1\.1 20\d /);
        c.socket.destroy();
      }
      expect(executions).toEqual(['live', 'action', 'inertia']);
    }, 30_000);

    it('keeps serving other clients during a slowloris attack and frees every connection', async () => {
      // A longer head bound, so every attacker is connected and holding its
      // socket while the legitimate requests run.
      const f = await start(platform, {
        http: { headersTimeoutMs: 4_000, requestTimeoutMs: 5_000 },
      });
      let accepted = 0;
      f.server.on('connection', () => accepted++);
      const [live] = targets(f.liveBody);
      const attackers = Array.from({ length: 150 }, () => {
        const c = client(f.port);
        void c.trickle(head(live.path, live.headers, 10) + '0123456789', 200);
        return c;
      });
      const deadline = Date.now() + 3_000;
      while (accepted < 150 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(accepted).toBe(150);
      expect(attackers.some((c) => c.isClosed())).toBe(false);
      // Legitimate traffic is unaffected while every attacker holds a socket.
      for (const path of ['/ping', '/inertia/dashboard']) {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${f.port}${path}`, {
          headers: { 'x-inertia': 'true', accept: 'application/json' },
        });
        expect(response.status, path).toBe(200);
        await response.arrayBuffer();
        expect(performance.now() - started, path).toBeLessThan(1_000);
      }
      expect(attackers.some((c) => c.isClosed())).toBe(false);
      await Promise.all(attackers.map((c) => c.closed));
      for (const c of attackers)
        expect(c.received()).toMatch(/^HTTP\/1\.1 408 /);
      expect(executions).toEqual([]);
      const end = Date.now() + 2_000;
      while ((await connections(f.server)) > 0 && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await connections(f.server)).toBe(0);
    }, 30_000);

    it('bounds the next request head on a kept-alive connection too', async () => {
      const f = await start(platform);
      const c = client(f.port);
      c.socket.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const end = Date.now() + 5_000;
      while (!c.received().includes('"ok":true') && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(c.received()).toMatch(/^HTTP\/1\.1 200 /);
      const answered = performance.now();
      // A second request trickled on the same connection.
      void c.trickle(
        'GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: 1\r\n\r\n',
        150,
      );
      await c.closed;
      expect(performance.now() - answered).toBeLessThan(3_500);
      expect(c.received().match(/HTTP\/1\.1 200 /g)).toHaveLength(1);
    }, 30_000);

    it('sets the bounds on Node too, and http: false leaves the server untouched', async () => {
      const bounded = await start(platform);
      expect(bounded.server.headersTimeout).toBe(bounds.headersTimeoutMs);
      expect(bounded.server.requestTimeout).toBe(bounds.requestTimeoutMs);
      const untouched = await start(platform, { http: false });
      // Without the bound Fastify disables Node's request timeout entirely
      // (requestTimeout 0: a trickled body is never cut off); Express keeps
      // Node's 300 s default, checked only every 30 s.
      expect(untouched.server.requestTimeout).toBe(
        platform === 'fastify' ? 0 : 300_000,
      );
      const defaults = await start(platform, {});
      expect(defaults.server.headersTimeout).toBe(30_000);
      expect(defaults.server.requestTimeout).toBe(300_000);
    }, 60_000);
  },
);

describe('boundHttpServer', () => {
  async function listen(server: HttpServer): Promise<number> {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    return address.port;
  }

  it('validates bounds and keeps the first bounds on repeated calls', () => {
    for (const options of [
      { headersTimeoutMs: 999 },
      { headersTimeoutMs: 600_001 },
      { requestTimeoutMs: 1.5 },
      { requestTimeoutMs: 3_600_001 },
      { headersTimeoutMs: Number.NaN },
    ])
      expect(() => normalizeHttpServerBounds(options)).toThrow(
        /Invalid HTTP server bound/,
      );
    expect(normalizeHttpServerBounds()).toEqual({
      headersTimeoutMs: 30_000,
      requestTimeoutMs: 300_000,
    });
    const server = createServer();
    expect(boundHttpServer(server, { headersTimeoutMs: 2_000 })).toMatchObject({
      headersTimeoutMs: 2_000,
    });
    expect(boundHttpServer(server, { headersTimeoutMs: 5_000 })).toMatchObject({
      headersTimeoutMs: 2_000,
    });
  });

  it('never cuts off an upgraded (WebSocket) connection, and leaves upgrades alone without a listener', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    boundHttpServer(server, { headersTimeoutMs: 1_000 });
    // Bounding adds no upgrade listener of its own.
    expect(server.listenerCount('upgrade')).toBe(0);
    const upgraded: Socket[] = [];
    server.on('upgrade', (_request, socket: Socket) => {
      upgraded.push(socket);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    expect(server.listenerCount('upgrade')).toBe(2);
    const port = await listen(server);
    // Runs before the server close above: Node waits for upgraded sockets.
    cleanup.push(() => {
      for (const socket of upgraded) socket.destroy();
    });
    const c = client(port);
    c.socket.write(
      'GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(c.received()).toMatch(/^HTTP\/1\.1 101 /);
    expect(c.isClosed()).toBe(false);
    expect(upgraded).toHaveLength(1);
  }, 15_000);

  it('does not cut off a long response once the request was received', async () => {
    // An SSE-style response that outlives requestTimeoutMs.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': open\n\n');
    });
    boundHttpServer(server, {
      headersTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    const port = await listen(server);
    const c = client(port);
    c.socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(c.received()).toMatch(/^HTTP\/1\.1 200 /);
    expect(c.isClosed()).toBe(false);
  }, 15_000);
});
