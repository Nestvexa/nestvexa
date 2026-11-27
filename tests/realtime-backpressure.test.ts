import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  MemoryRealtimeBroker,
  RealtimeHub,
  RealtimeModule,
  RealtimeService,
  attachRealtimeWebSocket,
  createTokenSigner,
} from '../packages/realtime/dist/index.js';
import type {
  RealtimeEvent,
  RealtimeSink,
} from '../packages/realtime/dist/index.js';

// REAL-011: the slow-consumer bound is drain-aware. A write that leaves the
// transport buffer above 256 KiB pauses delivery to that connection; later
// events wait in its bounded queue (`queueLimit`, `maxQueuedBytes`) and are
// written once the transport drains. Only a transport that does not drain
// within `drainTimeoutMs`, or a queue beyond its bound, closes the connection
// as `slow-consumer`. A burst far above 256 KiB published in one event-loop
// turn therefore reaches a healthy subscriber in full.

const secret = 'realtime-backpressure-secret-0123456789abcdef';
const alice = 'tenant-a/session/alice';
const bob = 'tenant-a/session/bob-xx';
const origin = 'http://127.0.0.1:3999';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
};

/**
 * A sink with a byte buffer that a simulated network empties one chunk per
 * macrotask, reporting congestion above `bound` and draining when empty.
 * `stalled` sinks never empty.
 */
function bufferedSink(options: { bound: number; stalled?: boolean }) {
  const events: RealtimeEvent[] = [];
  const closed: string[] = [];
  let buffered = 0;
  let listener: (() => void) | undefined;
  let peak = 0;
  const drainStep = () => {
    if (options.stalled || !buffered) return;
    buffered = Math.max(0, buffered - 32_768);
    if (!buffered && listener) {
      const call = listener;
      listener = undefined;
      call();
    }
    if (buffered) setImmediate(drainStep);
  };
  const value: RealtimeSink = {
    send(event) {
      events.push(event);
      buffered += JSON.stringify(event.data).length;
      peak = Math.max(peak, buffered);
      setImmediate(drainStep);
      return buffered < options.bound;
    },
    onDrain(callback) {
      if (!buffered) callback();
      else listener = callback;
    },
    heartbeat() {},
    close(reason) {
      closed.push(reason);
    },
  };
  return { value, events, closed, peak: () => peak };
}

function hub(limits: Partial<ConstructorParameters<typeof RealtimeHub>[3]>) {
  const broker = new MemoryRealtimeBroker({ replaySize: 0 });
  const signer = createTokenSigner({ secrets: [secret] });
  const instance = new RealtimeHub(
    broker,
    signer,
    { authorizeChannel: () => true },
    {
      maxConnections: 10,
      maxConnectionsPerIdentity: 4,
      queueLimit: 1024,
      heartbeatMs: 60_000,
      revalidateMs: 60_000,
      ...limits,
    },
  );
  cleanup.push(() => instance.shutdown());
  const connect = (binding: string, sink: RealtimeSink) =>
    instance.connect(
      () => ({ binding }),
      [signer.sign(binding, ['bulk'])],
      sink,
    );
  return { broker, hub: instance, connect };
}
const blob = 'x'.repeat(15_000);
/** 140 × 15 KB ≈ 2 MiB, eight times the 256 KiB transport bound, in one turn. */
async function burst(
  publish: (index: number) => Promise<unknown>,
  count = 140,
) {
  await Promise.all(
    Array.from({ length: count }, (_, index) => publish(index)),
  );
}

describe('drain-aware slow-consumer bound (hub)', () => {
  it('delivers a single-turn burst far above the transport bound to a draining subscriber', async () => {
    const f = hub({ drainTimeoutMs: 2000 });
    const healthy = bufferedSink({ bound: 262_144 });
    await f.connect(alice, healthy.value);
    await burst((index) => f.broker.publish('bulk', { index, blob }));
    // Synchronously only the transport bound was written: the rest waits.
    expect(healthy.events.length).toBeLessThan(140);
    await until(() => healthy.events.length === 140);
    expect(
      healthy.events.map((event) => Reflect.get(Object(event.data), 'index')),
    ).toEqual(Array.from({ length: 140 }, (_, index) => index));
    expect(healthy.closed).toEqual([]);
    expect(f.hub.size).toBe(1);
    // The transport never held much more than its bound.
    expect(healthy.peak()).toBeLessThan(262_144 + 20_000);
    // Still subscribed: a later event arrives too.
    await f.broker.publish('bulk', { index: 140 });
    await until(() => healthy.events.length === 141);
    expect(healthy.events).toHaveLength(141);
  });

  it('closes a congested subscriber that does not drain within drainTimeoutMs, without delaying others', async () => {
    const f = hub({ drainTimeoutMs: 300 });
    const healthy = bufferedSink({ bound: 262_144 });
    const stalled = bufferedSink({ bound: 262_144, stalled: true });
    await f.connect(alice, healthy.value);
    await f.connect(bob, stalled.value);
    await burst((index) => f.broker.publish('bulk', { index, blob }));
    const written = stalled.events.length;
    expect(written).toBeLessThan(140);
    expect(stalled.closed).toEqual([]);
    await until(() => stalled.closed.length > 0, 3000);
    expect(stalled.closed).toEqual(['slow-consumer']);
    // Nothing queued for it was written after the cut.
    expect(stalled.events).toHaveLength(written);
    await until(() => healthy.events.length === 140);
    expect(healthy.events).toHaveLength(140);
    expect(healthy.closed).toEqual([]);
    expect(f.hub.size).toBe(1);
  });

  it('closes a congested subscriber at once when its queue exceeds maxQueuedBytes or queueLimit', async () => {
    const bytes = hub({ maxQueuedBytes: 200_000, drainTimeoutMs: 60_000 });
    const byBytes = bufferedSink({ bound: 262_144, stalled: true });
    await bytes.connect(alice, byBytes.value);
    await burst((index) => bytes.broker.publish('bulk', { index, blob }));
    // 256 KiB written, then about 13 queued events of 15 KB fit in 200 KB.
    expect(byBytes.closed).toEqual(['slow-consumer']);
    expect(bytes.hub.size).toBe(0);
    const count = hub({ queueLimit: 8, drainTimeoutMs: 60_000 });
    const byCount = bufferedSink({ bound: 262_144, stalled: true });
    await count.connect(alice, byCount.value);
    await burst((index) => count.broker.publish('bulk', { index, blob }));
    expect(byCount.closed).toEqual(['slow-consumer']);
    expect(byCount.events.length).toBeLessThan(140);
  });

  it('closes at once when a sink cannot signal drain, and validates the new limits', async () => {
    const f = hub({});
    const events: RealtimeEvent[] = [];
    const closed: string[] = [];
    await f.connect(alice, {
      send: (event) => {
        events.push(event);
        return false;
      },
      heartbeat() {},
      close: (reason) => closed.push(reason),
    });
    await f.broker.publish('bulk', { index: 0 });
    expect(closed).toEqual(['slow-consumer']);
    expect(events).toHaveLength(1);
    for (const limits of [
      { maxQueuedBytes: 0 },
      { drainTimeoutMs: 1.5 },
      { drainTimeoutMs: -1 },
    ])
      expect(() => hub(limits)).toThrow(/Invalid realtime limit/);
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
          if (user !== 'alice' && user !== 'bob') throw new Error('anonymous');
          return { binding: user === 'alice' ? alice : bob };
        },
        authorizeChannel: (_identity, channel) => channel === 'bulk',
        limits: { drainTimeoutMs: 1000 },
      }),
    ],
  }).compile();
  const instance: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await instance.listen(0, '127.0.0.1');
  cleanup.push(() => instance.close());
  const service = instance.get(RealtimeService);
  return {
    instance,
    service,
    base: await instance.getUrl(),
    token: async (binding: string) =>
      (await service.sign({ binding }, ['bulk'])) ?? '',
  };
}

interface Received {
  ready: boolean;
  indexes: number[];
  closeReason: string | undefined;
  ended: boolean;
}
function record(received: Received, text: string): void {
  if (text.includes('"ready"') || text.includes('event: ready'))
    received.ready = true;
  const reason = /"reason":"([a-z-]+)"/.exec(text);
  if (text.includes('event: close') && reason) received.closeReason = reason[1];
  const index = /"index":(\d+)/.exec(text);
  if (index && text.includes('invalidate'))
    received.indexes.push(Number(index[1]));
}
/** SSE subscriber that parses frames incrementally; `paused` never reads. */
function sse(url: string, user: string, paused: boolean) {
  return new Promise<{
    received: Received;
    resume: () => void;
    close: () => void;
  }>((resolve, reject) => {
    const received: Received = {
      ready: false,
      indexes: [],
      closeReason: undefined,
      ended: false,
    };
    let rest = '';
    const request = httpRequest(
      url,
      { headers: { 'x-user': user } },
      (response) => {
        if (paused) response.pause();
        response.on('data', (chunk: Buffer) => {
          const frames = (rest + chunk.toString()).split('\n\n');
          rest = frames.pop() ?? '';
          for (const frame of frames) record(received, frame);
        });
        response.on('close', () => (received.ended = true));
        resolve({
          received,
          resume: () => response.resume(),
          close: () => request.destroy(),
        });
      },
    );
    cleanup.push(() => {
      request.destroy();
    });
    request.on('error', (error) =>
      received.ready ? undefined : reject(error),
    );
    request.end();
  });
}
/** WebSocket subscriber; `paused` stops reading its socket after `ready`. */
function websocket(url: string, token: string, paused: boolean) {
  return new Promise<{ received: Received; socket: WebSocket }>(
    (resolve, reject) => {
      const received: Received = {
        ready: false,
        indexes: [],
        closeReason: undefined,
        ended: false,
      };
      const socket = new WebSocket(url, { origin });
      cleanup.push(() => socket.terminate());
      socket.once('open', () =>
        socket.send(JSON.stringify({ tokens: [token] })),
      );
      socket.on('message', (data: Buffer) => {
        const text = data.toString('utf8');
        record(received, text);
        if (text.includes('"ready"')) {
          if (paused) socket.pause();
          resolve({ received, socket });
        }
      });
      socket.once('close', (code: number, reason: Buffer) => {
        received.ended = true;
        if (code === 4000) received.closeReason = reason.toString('utf8');
      });
      socket.once('error', reject);
    },
  );
}

describe.each(['express', 'fastify'] as const)(
  'single-turn burst over real transports on %s',
  (platform) => {
    it('keeps a healthy SSE subscriber connected through a 2 MiB single-turn burst and cuts a stalled one', async () => {
      const f = await app(platform);
      const endpoint = `${f.base}/_nestvexa/realtime/sse?t=`;
      const healthy = await sse(
        endpoint + (await f.token(alice)),
        'alice',
        false,
      );
      await until(() => healthy.received.ready);
      const stalled = await sse(endpoint + (await f.token(bob)), 'bob', true);
      await until(() => f.service.hub.size === 2);
      let published = 0;
      await burst(() =>
        f.service.publish('bulk', { index: published++, blob }),
      );
      await until(() => healthy.received.indexes.length === 140, 30_000);
      expect(healthy.received.indexes).toEqual(
        Array.from({ length: 140 }, (_, index) => index),
      );
      expect(healthy.received.closeReason).toBeUndefined();
      expect(healthy.received.ended).toBe(false);
      // The stalled subscriber is cut once the kernel buffers are full and its
      // transport stays congested past drainTimeoutMs (1 s here). Linux can
      // buffer several MiB on loopback, so keep publishing until it is cut.
      while (f.service.hub.size === 2 && published < 4000) {
        await burst(
          () => f.service.publish('bulk', { index: published++, blob }),
          50,
        );
        await until(
          () => healthy.received.indexes.length === published,
          30_000,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(f.service.hub.size).toBe(1);
      expect(published).toBeLessThan(4000);
      expect(healthy.received.indexes).toEqual(
        Array.from({ length: published }, (_, index) => index),
      );
      stalled.resume();
      await until(() => stalled.received.ended, 30_000);
      expect(stalled.received.closeReason).toBe('slow-consumer');
      // What the stalled subscriber did get arrived in order, without gaps.
      expect(stalled.received.indexes).toEqual(
        Array.from(
          { length: stalled.received.indexes.length },
          (_, index) => index,
        ),
      );
      healthy.close();
      await until(() => f.service.hub.size === 0);
      expect(f.service.hub.size).toBe(0);
    }, 120_000);

    it('keeps a healthy WebSocket subscriber connected through the same burst and cuts a stalled one', async () => {
      const f = await app(platform);
      const detach = await attachRealtimeWebSocket(f.instance);
      cleanup.push(detach);
      const url = `${f.base.replace('http', 'ws')}/_nestvexa/realtime/ws`;
      const healthy = await websocket(
        `${url}?as=alice`,
        await f.token(alice),
        false,
      );
      const stalled = await websocket(
        `${url}?as=bob`,
        await f.token(bob),
        true,
      );
      expect(f.service.hub.size).toBe(2);
      let published = 0;
      await burst(() =>
        f.service.publish('bulk', { index: published++, blob }),
      );
      await until(() => healthy.received.indexes.length === 140, 30_000);
      expect(healthy.received.indexes).toEqual(
        Array.from({ length: 140 }, (_, index) => index),
      );
      expect(healthy.received.ended).toBe(false);
      while (f.service.hub.size === 2 && published < 4000) {
        await burst(
          () => f.service.publish('bulk', { index: published++, blob }),
          50,
        );
        await until(
          () => healthy.received.indexes.length === published,
          30_000,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(f.service.hub.size).toBe(1);
      expect(published).toBeLessThan(4000);
      expect(healthy.received.indexes).toHaveLength(published);
      expect(healthy.received.ended).toBe(false);
      stalled.socket.resume();
      await until(() => stalled.received.ended, 30_000);
      expect(stalled.received.closeReason).toBe('slow-consumer');
      healthy.socket.close();
      await until(() => f.service.hub.size === 0);
      expect(f.service.hub.size).toBe(0);
    }, 120_000);
  },
);
