import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MemoryRealtimeBroker,
  RealtimeHub,
  RealtimeModule,
  RealtimeRejection,
  RealtimeService,
  RespRealtimeBroker,
  attachRealtimeWebSocket,
  createTokenSigner,
} from '../packages/realtime/dist/index.js';
import type {
  RealtimeEvent,
  RealtimeSink,
} from '../packages/realtime/dist/index.js';

const secret = 'realtime-test-secret-0123456789abcdefghij';
const alice = 'tenant-a/session/alice';
const bob = 'tenant-a/session/bob-xx';
const origin = 'http://127.0.0.1:3999';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
function sink() {
  const events: RealtimeEvent[] = [];
  const closed: string[] = [];
  let accept = true;
  const value: RealtimeSink = {
    send(event) {
      events.push(event);
      return accept;
    },
    heartbeat() {},
    close(reason) {
      closed.push(reason);
    },
  };
  return {
    value,
    events,
    closed,
    block: () => {
      accept = false;
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('subscription tokens', () => {
  it('signs identity-bound channel claims, rotates keys and rejects tampering', () => {
    const signer = createTokenSigner({ secrets: [secret] });
    const token = signer.sign(alice, ['orders:a', 'orders:a', 'jobs:b']);
    expect(signer.verify(token, alice).channels).toEqual([
      'jobs:b',
      'orders:a',
    ]);
    expect(() => signer.verify(token, bob)).toThrow(/another identity/);
    expect(() => signer.verify(token.slice(0, -2) + 'AA', alice)).toThrow();
    expect(() => signer.verify(token + '.x', alice)).toThrow();
    // The last character of a 43-character MAC has two unused bits; flipping
    // one decodes to the same bytes but is not the canonical spelling.
    const signature = token.split('.')[1] ?? '';
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias =
      alphabet[alphabet.indexOf(signature.at(-1) ?? 'A') ^ 1] ?? 'A';
    expect(Buffer.from(signature.slice(0, -1) + alias, 'base64url')).toEqual(
      Buffer.from(signature, 'base64url'),
    );
    expect(() => signer.verify(token.slice(0, -1) + alias, alice)).toThrow(
      /Invalid realtime token/,
    );
    expect(() => signer.verify(token, alice, Date.now() + 901_000)).toThrow(
      /Expired/,
    );
    const rotated = createTokenSigner({
      secrets: ['new-secret-abcdefghijklmnopqrstuvwxyz0123', secret],
    });
    expect(rotated.verify(token, alice).channels).toHaveLength(2);
    expect(() => createTokenSigner({ secrets: ['short'] })).toThrow();
    expect(() => signer.sign(alice, ['Bad Channel'])).toThrow();
    expect(() => signer.sign(alice, [])).toThrow();
  });
});

function hub(
  options: {
    authorize?: (binding: string, channel: string) => boolean;
    limits?: Partial<ConstructorParameters<typeof RealtimeHub>[3]>;
  } = {},
) {
  const broker = new MemoryRealtimeBroker({ replaySize: 5 });
  const signer = createTokenSigner({ secrets: [secret] });
  const instance = new RealtimeHub(
    broker,
    signer,
    {
      authorizeChannel: (identity, channel) =>
        options.authorize ? options.authorize(identity.binding, channel) : true,
    },
    {
      maxConnections: 10,
      maxConnectionsPerIdentity: 2,
      queueLimit: 4,
      heartbeatMs: 60_000,
      revalidateMs: 60_000,
      ...options.limits,
    },
  );
  cleanup.push(() => instance.shutdown());
  return { broker, signer, hub: instance };
}

describe('realtime hub', () => {
  it('delivers only subscribed channels, shares broker subscriptions and releases them', async () => {
    const f = hub();
    const a = sink();
    const b = sink();
    const first = await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['orders:a'])],
      a.value,
    );
    await f.hub.connect(
      () => ({ binding: bob }),
      [f.signer.sign(bob, ['orders:a', 'other'])],
      b.value,
    );
    expect(f.broker.subscriptions).toBe(2);
    await f.broker.publish('orders:a', { n: 1 });
    await f.broker.publish('unrelated', { n: 2 });
    await tick();
    expect(a.events.map((event) => event.data)).toEqual([{ n: 1 }]);
    expect(b.events.map((event) => event.data)).toEqual([{ n: 1 }]);
    first.close();
    expect(a.closed).toEqual(['client']);
    f.hub.shutdown();
    expect(f.broker.subscriptions).toBe(0);
    expect(b.closed).toEqual(['shutdown']);
  });

  it('rejects stolen tokens, unauthorized channels and connection floods', async () => {
    const f = hub({
      authorize: (binding, channel) =>
        channel !== 'secret' || binding === alice,
    });
    const token = f.signer.sign(alice, ['orders:a']);
    await expect(
      f.hub.connect(() => ({ binding: bob }), [token], sink().value),
    ).rejects.toMatchObject({ status: 403, code: 'INVALID_SUBSCRIPTION' });
    await expect(
      f.hub.connect(
        () => ({ binding: bob }),
        [f.signer.sign(bob, ['secret'])],
        sink().value,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'CHANNEL_FORBIDDEN' });
    await expect(
      f.hub.connect(
        () => {
          throw new Error('no session');
        },
        [token],
        sink().value,
      ),
    ).rejects.toBeInstanceOf(RealtimeRejection);
    await f.hub.connect(() => ({ binding: alice }), [token], sink().value);
    await f.hub.connect(() => ({ binding: alice }), [token], sink().value);
    await expect(
      f.hub.connect(() => ({ binding: alice }), [token], sink().value),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('closes slow consumers, revoked identities and replays missed events', async () => {
    const f = hub();
    const slow = sink();
    slow.block();
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['orders:a'])],
      slow.value,
    );
    await f.broker.publish('orders:a', 1);
    await tick();
    expect(slow.closed).toEqual(['slow-consumer']);
    const published = [];
    for (let index = 0; index < 4; index++)
      published.push(await f.broker.publish('orders:a', index));
    const replayed = sink();
    await f.hub.connect(
      () => ({ binding: bob }),
      [f.signer.sign(bob, ['orders:a'])],
      replayed.value,
      new Map([['orders:a', published[1]?.id ?? '']]),
    );
    await tick();
    expect(replayed.events.map((event) => event.data)).toEqual([2, 3]);
    expect(f.hub.revoke(bob)).toBe(1);
    expect(replayed.closed).toEqual(['revoked']);
  });

  it('re-authorizes before delivery after the revalidation window', async () => {
    let allowed = true;
    const f = hub({
      authorize: () => allowed,
      limits: { revalidateMs: 1000 },
    });
    const s = sink();
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['orders:a'])],
      s.value,
    );
    allowed = false;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await f.broker.publish('orders:a', 'private');
    await tick();
    expect(s.events).toEqual([]);
    expect(s.closed).toEqual(['forbidden']);
  });
});

/** In-process RESP test double implementing SUBSCRIBE/PUBLISH only. Not Redis. */
async function fakeRedis(): Promise<{
  port: number;
  server: Server;
  /** Resets every client connection, like a server restart. */
  drop: () => void;
}> {
  const subscribers = new Map<string, Set<Socket>>();
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => {
      connections.delete(socket);
      for (const set of subscribers.values()) set.delete(socket);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const match = /^\*(\d+)\r\n/.exec(buffer);
        if (!match) return;
        let offset = match[0].length;
        const parts: string[] = [];
        for (let index = 0; index < Number(match[1]); index++) {
          const header = /^\$(\d+)\r\n/.exec(buffer.slice(offset));
          if (!header) return;
          offset += header[0].length;
          const length = Number(header[1]);
          if (buffer.length < offset + length + 2) return;
          parts.push(buffer.slice(offset, offset + length));
          offset += length + 2;
        }
        buffer = buffer.slice(offset);
        const [name, channel = '', message = ''] = parts;
        if (name === 'SUBSCRIBE') {
          const set = subscribers.get(channel) ?? new Set();
          set.add(socket);
          subscribers.set(channel, set);
          socket.write(
            `*3\r\n$9\r\nsubscribe\r\n$${channel.length}\r\n${channel}\r\n:1\r\n`,
          );
        } else if (name === 'PUBLISH') {
          const targets = subscribers.get(channel) ?? new Set();
          for (const target of targets)
            target.write(
              `*3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n$${Buffer.byteLength(message)}\r\n${message}\r\n`,
            );
          socket.write(`:${targets.size}\r\n`);
        } else socket.write('-ERR unsupported\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    port: address.port,
    server,
    drop: () => {
      for (const socket of connections) socket.destroy();
    },
  };
}

describe('RESP broker (two replicas, test double server)', () => {
  it('delivers an event published by replica A to subscribers on replica B', async () => {
    const redis = await fakeRedis();
    cleanup.push(
      () => new Promise<void>((resolve) => redis.server.close(() => resolve())),
    );
    const a = new RespRealtimeBroker({ port: redis.port, prefix: 'app1:' });
    const b = new RespRealtimeBroker({ port: redis.port, prefix: 'app1:' });
    const other = new RespRealtimeBroker({ port: redis.port, prefix: 'app2:' });
    cleanup.push(
      () => a.close(),
      () => b.close(),
      () => other.close(),
    );
    const received: RealtimeEvent[] = [];
    const isolated: RealtimeEvent[] = [];
    await b.subscribe('orders:tenant-a', (event) => received.push(event));
    await other.subscribe('orders:tenant-a', (event) => isolated.push(event));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const event = await a.publish('orders:tenant-a', { total: 3 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: 'orders:tenant-a',
      data: { total: 3 },
      id: event.id,
    });
    expect(isolated).toEqual([]);
    expect(b.replay('orders:tenant-a', 'unknown')).toEqual([]);
  });

  it('resubscribes after the server drops every connection', async () => {
    const redis = await fakeRedis();
    cleanup.push(
      () => new Promise<void>((resolve) => redis.server.close(() => resolve())),
    );
    const a = new RespRealtimeBroker({ port: redis.port });
    const b = new RespRealtimeBroker({ port: redis.port });
    cleanup.push(
      () => a.close(),
      () => b.close(),
    );
    const received: unknown[] = [];
    await b.subscribe('board:1', (event) => received.push(event.data));
    await new Promise((resolve) => setTimeout(resolve, 50));
    redis.drop();
    // Events published while disconnected are lost; later ones must arrive.
    await expect
      .poll(
        async () => {
          await a.publish('board:1', { after: 'restart' }).catch(() => 0);
          return received.length;
        },
        { timeout: 5000, interval: 150 },
      )
      .toBeGreaterThan(0);
    expect(received[0]).toEqual({ after: 'restart' });
  });
});

async function app(platform: 'express' | 'fastify') {
  const module = await Test.createTestingModule({
    imports: [
      RealtimeModule.forRoot({
        secrets: [secret],
        origin,
        resolveIdentity: (request) => {
          const user = Reflect.get(
            Reflect.get(request, 'headers') as object,
            'x-user',
          );
          if (user !== 'alice' && user !== 'bob') throw new Error('anonymous');
          return { binding: user === 'alice' ? alice : bob };
        },
        resolveUpgradeIdentity: (request: IncomingMessage) => {
          const user = new URL(request.url ?? '/', 'http://x').searchParams.get(
            'as',
          );
          if (user !== 'alice') throw new Error('anonymous');
          return { binding: alice };
        },
        authorizeChannel: (identity, channel) =>
          channel === 'public' ||
          (channel === 'private:alice' && identity.binding === alice),
        limits: { heartbeatMs: 1000 },
      }),
    ],
  }).compile();
  const instance: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await instance.listen(0, '127.0.0.1');
  cleanup.push(() => instance.close());
  return {
    instance,
    service: instance.get(RealtimeService),
    base: await instance.getUrl(),
  };
}
function stream(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; read: () => string; close: () => void }>(
    (resolve, reject) => {
      let text = '';
      const request = httpRequest(url, { headers }, (response) => {
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        resolve({
          status: response.statusCode ?? 0,
          read: () => text,
          close: () => request.destroy(),
        });
      });
      request.on('error', (error) => (text ? undefined : reject(error)));
      request.end();
    },
  );
}
const until = async (check: () => boolean) => {
  for (let index = 0; index < 100 && !check(); index++)
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe.each(['express', 'fastify'] as const)(
  'realtime HTTP transports: %s',
  (platform) => {
    it('streams authorized SSE invalidations and replays after Last-Event-ID', async () => {
      const f = await app(platform);
      const token = await f.service.sign({ binding: alice }, [
        'public',
        'private:alice',
        'admin',
      ]);
      expect(token).toBeDefined();
      expect(f.service.signer.verify(token ?? '', alice).channels).toEqual([
        'private:alice',
        'public',
      ]);
      const sse = await stream(`${f.base}/_nestvexa/realtime/sse?t=${token}`, {
        'x-user': 'alice',
      });
      expect(sse.status).toBe(200);
      await until(() => sse.read().includes('event: ready'));
      await f.service.publish('private:alice', { n: 1 });
      await until(() => sse.read().includes('event: invalidate'));
      const cursor = /id: (\S+)/.exec(sse.read())?.[1] ?? '';
      expect(sse.read()).toContain('"data":{"n":1}');
      sse.close();
      await f.service.publish('private:alice', { n: 2 });
      const resumed = await stream(
        `${f.base}/_nestvexa/realtime/sse?t=${token}`,
        {
          'x-user': 'alice',
          'last-event-id': cursor,
        },
      );
      await until(() => resumed.read().includes('"n":2'));
      expect(resumed.read()).not.toContain('"n":1');
      resumed.close();
      const stolen = await stream(
        `${f.base}/_nestvexa/realtime/sse?t=${token}`,
        { 'x-user': 'bob' },
      );
      expect(stolen.status).toBe(403);
      stolen.close();
    });

    it('long-polls events after a cursor', async () => {
      const f = await app(platform);
      const token = (await f.service.sign({ binding: bob }, ['public'])) ?? '';
      const pending = new Promise<{ status: number; body: string }>(
        (resolve) => {
          httpRequest(
            `${f.base}/_nestvexa/realtime/poll?t=${token}`,
            { headers: { 'x-user': 'bob' } },
            (response) => {
              let body = '';
              response.on(
                'data',
                (chunk: Buffer) => (body += chunk.toString()),
              );
              response.on('end', () =>
                resolve({ status: response.statusCode ?? 0, body }),
              );
            },
          ).end();
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await f.service.publish('public', 'hello');
      const result = await pending;
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).events).toMatchObject([
        { channel: 'public', data: 'hello' },
      ]);
    });

    it('accepts WebSocket subscriptions only from the configured origin', async () => {
      const f = await app(platform);
      const detach = await attachRealtimeWebSocket(f.instance);
      cleanup.push(detach);
      const wsBase = f.base.replace('http', 'ws');
      const token =
        (await f.service.sign({ binding: alice }, ['public'])) ?? '';
      const hijack = new WebSocket(`${wsBase}/_nestvexa/realtime/ws?as=alice`, {
        headers: { origin: 'https://evil.example' },
      });
      const hijackError = await new Promise<string>((resolve) => {
        hijack.on('unexpected-response', (_request, response) =>
          resolve(String(response.statusCode)),
        );
        hijack.on('error', () => resolve('error'));
      });
      expect(hijackError).toBe('403');
      const socket = new WebSocket(`${wsBase}/_nestvexa/realtime/ws?as=alice`, {
        headers: { origin },
      });
      const messages: unknown[] = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ tokens: [token] }));
      await until(() => messages.length > 0);
      expect(messages[0]).toEqual({ type: 'ready' });
      await f.service.publish('public', { n: 7 });
      await until(() => messages.length > 1);
      expect(messages[1]).toMatchObject({
        type: 'invalidate',
        channel: 'public',
        data: { n: 7 },
      });
      const closed = new Promise<number>((resolve) =>
        socket.on('close', (code) => resolve(code)),
      );
      f.service.revoke(alice);
      expect(await closed).toBe(4000);
    });
  },
);
