import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MemoryPresenceStore,
  RealtimeModule,
  RealtimeService,
  RespRealtimeBroker,
  attachRealtimeWebSocket,
} from '../packages/realtime/dist/index.js';
import type {
  PresenceMember,
  PresenceStore,
  RealtimeModuleOptions,
  RealtimeTransportName,
} from '../packages/realtime/dist/index.js';
import { RedisPresenceStore } from '../packages/realtime-redis/dist/realtime.js';
import { respDouble } from './support/resp-double.js';

/*
 * Cross-replica realtime: presence shared through a store (RedisPresenceStore
 * over the in-process RESP double; real Redis in `pnpm test:services`),
 * replica death, and transport capability negotiation, on Express and
 * Fastify replicas side by side.
 */
const secret = 'realtime-distributed-secret-0123456789abc';
const origin = 'http://127.0.0.1:3999';
const users: Record<string, string> = {
  alice: 'tenant-a/session/alice',
  bob: 'tenant-a/session/bob-xx',
  carol: 'tenant-b/session/carol',
};
const members: Record<string, PresenceMember> = {
  [users['alice'] ?? '']: { id: 'u-alice', label: 'Alice' },
  [users['bob'] ?? '']: { id: 'u-bob' },
  [users['carol'] ?? '']: { id: 'u-carol' },
};
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(20);
  }
  throw new Error('condition not reached');
}
const tenantOf = (binding: string) => binding.split('/')[0] ?? '';
function resolve(user: unknown) {
  const binding = typeof user === 'string' ? users[user] : undefined;
  if (!binding) throw new Error('anonymous');
  return { binding };
}

async function replica(
  platform: 'express' | 'fastify',
  overrides: Partial<RealtimeModuleOptions> = {},
) {
  const module = await Test.createTestingModule({
    imports: [
      RealtimeModule.forRoot({
        secrets: [secret],
        origin,
        resolveIdentity: (request) =>
          resolve(
            Reflect.get(Reflect.get(request, 'headers') as object, 'x-user'),
          ),
        resolveUpgradeIdentity: (request: IncomingMessage) =>
          resolve(
            new URL(request.url ?? '/', 'http://x').searchParams.get('as'),
          ),
        authorizeChannel: (identity, channel) =>
          channel.startsWith(`${tenantOf(identity.binding)}:`),
        describePresence: (identity) => members[identity.binding],
        ...overrides,
      }),
    ],
  }).compile();
  const app: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  let closed = false;
  cleanup.push(async () => {
    if (!closed) await app.close();
  });
  return {
    app,
    service: app.get(RealtimeService),
    base: await app.getUrl(),
    close: async () => {
      closed = true;
      await app.close();
    },
  };
}
function get(url: string, user?: string) {
  return new Promise<{ status: number; body: string }>((done, reject) => {
    httpRequest(url, { headers: user ? { 'x-user': user } : {} }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}
function sse(url: string, user: string) {
  return new Promise<{ read: () => string; close: () => void }>(
    (done, reject) => {
      let text = '';
      const request = httpRequest(
        url,
        { headers: { 'x-user': user } },
        (res) => {
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          done({ read: () => text, close: () => request.destroy() });
        },
      );
      request.on('error', (error) => (text ? undefined : reject(error)));
      request.end();
    },
  );
}
async function websocket(base: string, user: string, token: string) {
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/_nestvexa/realtime/ws?as=${user}`,
    { headers: { origin } },
  );
  const messages: string[] = [];
  ws.on('message', (data) => messages.push(String(data)));
  await new Promise((done) => ws.once('open', done));
  ws.send(JSON.stringify({ tokens: [token] }));
  await until(() => messages.some((message) => message.includes('"ready"')));
  return { ws, messages };
}
/** A store whose writes stop, as when the replica process is killed. */
function killable(store: PresenceStore) {
  let dead = false;
  const wrapped: PresenceStore = {
    write: (...args) => (dead ? Promise.resolve() : store.write(...args)),
    remove: (...args) => (dead ? Promise.resolve() : store.remove(...args)),
    read: (channel) => store.read(channel),
    close: () => store.close(),
  };
  return { store: wrapped, kill: () => (dead = true) };
}
const ids = (snapshot: { members: readonly PresenceMember[] }) =>
  snapshot.members.map((member) => member.id);

describe('presence across replicas', () => {
  it('merges members from an Express and a Fastify replica through Redis and drops a dead replica after its TTL', async () => {
    const double = await respDouble();
    cleanup.push(() => double.close());
    const store = () =>
      new RedisPresenceStore({ port: double.port, prefix: 'p1:' });
    const broker = () =>
      new RespRealtimeBroker({ port: double.port, prefix: 'rt1:' });
    const b = killable(store());
    const a = await replica('express', {
      broker: broker(),
      presence: { store: store(), ttlMs: 3000 },
    });
    const bReplica = await replica('fastify', {
      broker: broker(),
      presence: { store: b.store, ttlMs: 3000 },
    });
    await attachRealtimeWebSocket(bReplica.app);
    const alice = { binding: users['alice'] ?? '' };
    const bob = { binding: users['bob'] ?? '' };
    const aliceToken = (await a.service.sign(alice, ['tenant-a:room'])) ?? '';
    const bobToken =
      (await bReplica.service.sign(bob, ['tenant-a:room'])) ?? '';
    const stream = await sse(
      `${a.base}/_nestvexa/realtime/sse?t=${aliceToken}`,
      'alice',
    );
    await until(() => stream.read().includes('event: ready'));
    const socket = await websocket(bReplica.base, 'bob', bobToken);
    // Either replica reports both members, deduplicated and sorted.
    await until(async () => {
      const seen = await a.service.presence(alice, 'tenant-a:room');
      return seen.total === 2;
    });
    expect(await a.service.presence(alice, 'tenant-a:room')).toEqual({
      channel: 'tenant-a:room',
      members: [{ id: 'u-alice', label: 'Alice' }, { id: 'u-bob' }],
      total: 2,
      truncated: false,
    });
    expect(ids(await bReplica.service.presence(bob, 'tenant-a:room'))).toEqual([
      'u-alice',
      'u-bob',
    ]);
    // Other tenants can neither read presence nor appear in it.
    await expect(
      a.service.presence({ binding: users['carol'] ?? '' }, 'tenant-a:room'),
    ).rejects.toMatchObject({ status: 403 });
    // Store keys never contain bindings or session identifiers.
    expect([...double.values.keys()].join('\n')).not.toMatch(/session|alice/);
    // Replica b is killed: its WebSocket stays open (the process is gone, not
    // closed) but its entry is no longer refreshed and lapses after the TTL.
    b.kill();
    await until(
      async () =>
        (await a.service.presence(alice, 'tenant-a:room')).total === 1,
      8000,
    );
    expect(ids(await a.service.presence(alice, 'tenant-a:room'))).toEqual([
      'u-alice',
    ]);
    socket.ws.close();
    stream.close();
  }, 20_000);

  it('updates promptly on disconnect and removes entries on graceful shutdown', async () => {
    const shared = new MemoryPresenceStore();
    const a = await replica('fastify', { presence: { store: shared } });
    const b = await replica('express', { presence: { store: shared } });
    const alice = { binding: users['alice'] ?? '' };
    const bob = { binding: users['bob'] ?? '' };
    const bobToken = (await b.service.sign(bob, ['tenant-a:room'])) ?? '';
    const stream = await sse(
      `${b.base}/_nestvexa/realtime/sse?t=${bobToken}`,
      'bob',
    );
    await until(
      async () =>
        (await a.service.presence(alice, 'tenant-a:room')).total === 1,
    );
    stream.close();
    await until(
      async () =>
        (await a.service.presence(alice, 'tenant-a:room')).total === 0,
    );
    const again = await sse(
      `${b.base}/_nestvexa/realtime/sse?t=${bobToken}`,
      'bob',
    );
    await until(
      async () =>
        (await a.service.presence(alice, 'tenant-a:room')).total === 1,
    );
    // Graceful shutdown removes b's entries without waiting for the TTL.
    await b.close();
    expect(await shared.read('tenant-a:room')).toEqual([]);
    expect((await a.service.presence(alice, 'tenant-a:room')).total).toBe(0);
    again.close();
  });

  it('treats store contents as untrusted and bounds the merged result', async () => {
    const shared = new MemoryPresenceStore();
    const a = await replica('express', {
      presence: { store: shared },
      limits: { maxPresenceMembers: 2 },
    });
    const alice = { binding: users['alice'] ?? '' };
    const forged = {
      members: [{ id: 'ok-1' }, { id: '<script>' }],
      total: 2,
    } as unknown as { members: PresenceMember[]; total: number };
    await shared.write('replica-forged-1', 'tenant-a:room', forged, 10_000);
    await shared.write(
      'replica-negative',
      'tenant-a:room',
      { members: [{ id: 'neg' }], total: -1 },
      10_000,
    );
    await shared.write(
      'replica-good-01',
      'tenant-a:room',
      { members: [{ id: 'm-1' }, { id: 'm-2' }], total: 40 },
      10_000,
    );
    const seen = await a.service.presence(alice, 'tenant-a:room');
    // The entry with an invalid member and the one with a bad total are dropped.
    expect(ids(seen)).toEqual(['m-1', 'm-2']);
    // b listed 2 of its 40: the total is a lower bound and marked truncated.
    expect(seen).toMatchObject({ total: 40, truncated: true });
    // An unreachable store degrades to this replica's own members.
    const broken = await replica('fastify', {
      presence: {
        store: {
          write: () => Promise.reject(new Error('down')),
          remove: () => Promise.reject(new Error('down')),
          read: () => Promise.reject(new Error('down')),
          close: () => Promise.resolve(),
        },
      },
    });
    expect(await broken.service.presence(alice, 'tenant-a:room')).toEqual({
      channel: 'tenant-a:room',
      members: [],
      total: 0,
      truncated: false,
    });
  });

  it('validates presence options and Redis entries', async () => {
    await expect(
      replica('express', {
        presence: { store: {} as unknown as PresenceStore },
      }),
    ).rejects.toThrow(/PresenceStore/);
    await expect(
      replica('express', {
        presence: { store: new MemoryPresenceStore(), ttlMs: 10 },
      }),
    ).rejects.toThrow(/ttlMs/);
    const double = await respDouble();
    cleanup.push(() => double.close());
    const store = new RedisPresenceStore({ port: double.port, prefix: 'v:' });
    cleanup.push(() => store.close());
    await expect(
      store.write(
        'bad replica',
        'tenant-a:room',
        { members: [], total: 0 },
        1000,
      ),
    ).rejects.toThrow(/Invalid/);
    await store.write(
      'replica-0001',
      'tenant-a:room',
      { members: [{ id: 'x' }], total: 1 },
      1000,
    );
    double.values.set('v:pm:replica-0002:tenant-a:room', 'not json');
    double.values.set(
      'v:pr:tenant-a:room',
      new Set(['replica-0001', 'replica-0002', 'replica-0003']),
    );
    // Malformed and missing entries are skipped; missing ones leave the index.
    expect(await store.read('tenant-a:room')).toEqual([
      { replica: 'replica-0001', members: [{ id: 'x' }], total: 1 },
    ]);
    expect([
      ...(double.values.get('v:pr:tenant-a:room') as Set<string>),
    ]).toEqual(['replica-0001', 'replica-0002']);
    expect(await store.read('Bad Channel')).toEqual([]);
    expect(() => new RedisPresenceStore({ prefix: 'Bad Prefix' })).toThrow();
  });

  it('keeps a long-lived replica when one with a shorter TTL lapses (Redis)', async () => {
    const double = await respDouble();
    cleanup.push(() => double.close());
    const store = new RedisPresenceStore({ port: double.port, prefix: 't:' });
    cleanup.push(() => store.close());
    await store.write(
      'replica-long-01',
      'tenant-a:room',
      { members: [{ id: 'u-alice' }], total: 1 },
      30_000,
    );
    // A later write with a short TTL must not shorten the shared index.
    await store.write(
      'replica-short-1',
      'tenant-a:room',
      { members: [{ id: 'u-bob' }], total: 1 },
      100,
    );
    await wait(200);
    expect(
      (await store.read('tenant-a:room')).map((entry) => entry.replica),
    ).toEqual(['replica-long-01']);
  });
});

describe.each(['express', 'fastify'] as const)(
  'transport negotiation on %s',
  (platform) => {
    it('advertises WebSocket only once attached, in configured order', async () => {
      const f = await replica(platform);
      const before = await get(`${f.base}/_nestvexa/realtime/negotiate`);
      expect(before.status).toBe(200);
      expect(JSON.parse(before.body)).toEqual({
        transports: ['sse', 'polling'],
      });
      const detach = await attachRealtimeWebSocket(f.app);
      const after = await get(`${f.base}/_nestvexa/realtime/negotiate`);
      expect(JSON.parse(after.body)).toEqual({
        transports: ['websocket', 'sse', 'polling'],
      });
      detach();
      expect(f.service.transports).toEqual(['sse', 'polling']);
    });

    it('refuses disabled transports and rejects invalid transport options', async () => {
      const f = await replica(platform, { transports: ['polling'] });
      const token =
        (await f.service.sign({ binding: users['alice'] ?? '' }, [
          'tenant-a:feed',
        ])) ?? '';
      const stream = await get(
        `${f.base}/_nestvexa/realtime/sse?t=${token}`,
        'alice',
      );
      expect(stream.status).toBe(404);
      expect(stream.body).toContain('TRANSPORT_DISABLED');
      expect(
        JSON.parse((await get(`${f.base}/_nestvexa/realtime/negotiate`)).body),
      ).toEqual({ transports: ['polling'] });
      await expect(attachRealtimeWebSocket(f.app)).rejects.toThrow(/disabled/);
      for (const transports of [[], ['sse', 'sse'], ['carrier-pigeon']])
        await expect(
          replica(platform, {
            transports: transports as RealtimeTransportName[],
          }),
        ).rejects.toThrow(/transports/);
    });
  },
);

it('detects at startup that an adapter cannot carry WebSockets', async () => {
  const f = await replica('express');
  const app = {
    get: (token: unknown) => f.app.get(token as typeof RealtimeService),
    getHttpServer: () => ({}),
  } as unknown as INestApplication;
  await expect(attachRealtimeWebSocket(app)).rejects.toThrow(
    /Node HTTP server/,
  );
});
