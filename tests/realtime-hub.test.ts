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
  PresenceMember,
  RealtimeEvent,
  RealtimeModuleOptions,
  RealtimeSink,
} from '../packages/realtime/dist/index.js';

const secret = 'realtime-hub-secret-0123456789abcdefghijk';
const alice = 'tenant-a/session/alice';
const bob = 'tenant-a/session/bob-xx';
const carol = 'tenant-b/session/carol';
const origin = 'http://127.0.0.1:3999';
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
function sink() {
  const events: RealtimeEvent[] = [];
  const closed: string[] = [];
  let beats = 0;
  const value: RealtimeSink = {
    send(event) {
      events.push(event);
      return true;
    },
    heartbeat() {
      beats++;
    },
    close(reason) {
      closed.push(reason);
    },
  };
  return { value, events, closed, beats: () => beats };
}
const tenantOf = (binding: string) => binding.split('/')[0] ?? '';
const members: Record<string, PresenceMember> = {
  [alice]: { id: 'u-alice', label: 'Alice' },
  [bob]: { id: 'u-bob' },
  [carol]: { id: 'u-carol' },
};
function hub(
  options: {
    authorize?: (binding: string, channel: string) => boolean;
    describe?: (binding: string) => PresenceMember | undefined;
    limits?: Partial<ConstructorParameters<typeof RealtimeHub>[3]>;
  } = {},
) {
  const broker = new MemoryRealtimeBroker({ replaySize: 5 });
  const signer = createTokenSigner({ secrets: [secret] });
  const describe = options.describe;
  const instance = new RealtimeHub(
    broker,
    signer,
    {
      // Tenant channels: `<tenant>:...` is readable only inside that tenant.
      authorizeChannel: (identity, channel) =>
        options.authorize
          ? options.authorize(identity.binding, channel)
          : channel.startsWith(`${tenantOf(identity.binding)}:`),
      ...(describe
        ? { describePresence: (identity) => describe(identity.binding) }
        : {}),
    },
    {
      maxConnections: 10,
      maxConnectionsPerIdentity: 4,
      queueLimit: 8,
      heartbeatMs: 60_000,
      revalidateMs: 60_000,
      ...options.limits,
    },
  );
  cleanup.push(() => instance.shutdown());
  return { broker, signer, hub: instance };
}

describe('realtime hub lifecycle', () => {
  it('closes a connection when its subscription token expires', async () => {
    const f = hub();
    const s = sink();
    // Signed 300 ms before the 15-minute default lifetime runs out.
    const token = f.signer.sign(
      alice,
      ['tenant-a:orders'],
      Date.now() - 899_700,
    );
    await f.hub.connect(() => ({ binding: alice }), [token], s.value);
    expect(s.closed).toEqual([]);
    await until(() => s.closed.length > 0);
    expect(s.closed).toEqual(['expired']);
    expect(f.hub.size).toBe(0);
    await f.broker.publish('tenant-a:orders', 'late');
    await wait(20);
    expect(s.events).toEqual([]);
  });

  it('revalidates identity periodically: a changed binding or expired session closes the connection', async () => {
    const f = hub({ limits: { revalidateMs: 100 } });
    let current: string | undefined = alice;
    const switched = sink();
    await f.hub.connect(
      () => {
        if (current === undefined) throw new Error('session expired');
        return { binding: current };
      },
      [f.signer.sign(alice, ['tenant-a:orders'])],
      switched.value,
    );
    let session = true;
    const expiring = sink();
    await f.hub.connect(
      () => {
        if (!session) throw new Error('session expired');
        return { binding: bob };
      },
      [f.signer.sign(bob, ['tenant-a:orders'])],
      expiring.value,
    );
    await wait(150);
    expect(switched.closed).toEqual([]);
    current = bob; // the same cookie now resolves to another user
    session = false;
    await until(() => switched.closed.length > 0 && expiring.closed.length > 0);
    expect(switched.closed).toEqual(['revoked']);
    expect(expiring.closed).toEqual(['revoked']);
    expect(f.hub.size).toBe(0);
  });

  it('closes on revalidation when channel permission is withdrawn, and isolates tenants', async () => {
    let allowed = true;
    const f = hub({
      authorize: (binding, channel) =>
        channel.startsWith(`${tenantOf(binding)}:`) &&
        (allowed || binding !== alice),
      limits: { revalidateMs: 100 },
    });
    const a = sink();
    const b = sink();
    const c = sink();
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:orders'])],
      a.value,
    );
    await f.hub.connect(
      () => ({ binding: bob }),
      [f.signer.sign(bob, ['tenant-a:orders'])],
      b.value,
    );
    await f.hub.connect(
      () => ({ binding: carol }),
      [f.signer.sign(carol, ['tenant-b:orders'])],
      c.value,
    );
    // A tenant-b identity cannot subscribe to tenant-a, even with a valid token.
    await expect(
      f.hub.connect(
        () => ({ binding: carol }),
        [f.signer.sign(carol, ['tenant-a:orders'])],
        sink().value,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'CHANNEL_FORBIDDEN' });
    await f.broker.publish('tenant-a:orders', 'a-only');
    await wait(20);
    expect(c.events).toEqual([]);
    expect(a.events.map((event) => event.data)).toEqual(['a-only']);
    allowed = false;
    await until(() => a.closed.length > 0);
    expect(a.closed).toEqual(['forbidden']);
    expect(b.closed).toEqual([]);
  });

  it('sends heartbeats on the configured interval', async () => {
    const f = hub({ limits: { heartbeatMs: 50 } });
    const s = sink();
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:orders'])],
      s.value,
    );
    await until(() => s.beats() >= 2);
    f.hub.shutdown();
    const beats = s.beats();
    await wait(120);
    expect(s.beats()).toBe(beats);
    expect(s.closed).toEqual(['shutdown']);
  });

  it('closeChannel closes only that channel and rejects new connections after shutdown', async () => {
    const f = hub();
    const orders = sink();
    const invoices = sink();
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:orders'])],
      orders.value,
    );
    await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:invoices'])],
      invoices.value,
    );
    expect(f.broker.subscriptions).toBe(2);
    f.hub.closeChannel('tenant-a:orders');
    expect(orders.closed).toEqual(['forbidden']);
    expect(invoices.closed).toEqual([]);
    // No subscription leaks: the broker subscription went with the last subscriber.
    expect(f.broker.subscriptions).toBe(1);
    expect(() => f.hub.closeChannel('Bad Channel')).toThrow();
    f.hub.shutdown();
    expect(f.broker.subscriptions).toBe(0);
    await expect(
      f.hub.connect(
        () => ({ binding: alice }),
        [f.signer.sign(alice, ['tenant-a:orders'])],
        sink().value,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'REALTIME_SHUTDOWN' });
  });
});

describe('realtime presence', () => {
  it('lists distinct authorized members per channel, bounded and released on close', async () => {
    const f = hub({
      describe: (binding) => members[binding],
      limits: { maxPresenceMembers: 1 },
    });
    const first = await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:room'])],
      sink().value,
    );
    // A second tab of the same member is not counted twice.
    const tab = await f.hub.connect(
      () => ({ binding: alice }),
      [f.signer.sign(alice, ['tenant-a:room'])],
      sink().value,
    );
    expect(f.hub.presence('tenant-a:room')).toEqual({
      channel: 'tenant-a:room',
      members: [{ id: 'u-alice', label: 'Alice' }],
      total: 1,
      truncated: false,
    });
    const bobs = await f.hub.connect(
      () => ({ binding: bob }),
      [f.signer.sign(bob, ['tenant-a:room'])],
      sink().value,
    );
    expect(f.hub.presence('tenant-a:room')).toMatchObject({
      members: [{ id: 'u-alice' }],
      total: 2,
      truncated: true,
    });
    first.close();
    tab.close();
    expect(f.hub.presence('tenant-a:room')).toMatchObject({
      members: [{ id: 'u-bob' }],
      total: 1,
    });
    bobs.close();
    expect(f.hub.presence('tenant-a:room').total).toBe(0);
    expect(f.hub.presence('tenant-a:other').members).toEqual([]);
    expect(JSON.stringify(f.hub.presence('tenant-a:room'))).not.toContain(
      'session',
    );
  });

  it('rejects invalid presence descriptors at connect', async () => {
    const f = hub({
      describe: () => ({ id: 'has spaces and <html>' }),
    });
    await expect(
      f.hub.connect(
        () => ({ binding: alice }),
        [f.signer.sign(alice, ['tenant-a:room'])],
        sink().value,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'PRESENCE_REJECTED' });
    expect(f.hub.size).toBe(0);
  });
});

describe('realtime rate limits and payload quota', () => {
  it('limits subscription attempts per identity, counting rejected tokens', async () => {
    const f = hub({ limits: { subscribesPerMinute: 3 } });
    const token = f.signer.sign(alice, ['tenant-a:orders']);
    await expect(
      f.hub.connect(() => ({ binding: alice }), ['forged.token'], sink().value),
    ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION' });
    (
      await f.hub.connect(() => ({ binding: alice }), [token], sink().value)
    ).close();
    (
      await f.hub.connect(() => ({ binding: alice }), [token], sink().value)
    ).close();
    await expect(
      f.hub.connect(() => ({ binding: alice }), [token], sink().value),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    // Other identities keep their own budget.
    await f.hub.connect(
      () => ({ binding: bob }),
      [f.signer.sign(bob, ['tenant-a:orders'])],
      sink().value,
    );
    expect(() => hub({ limits: { subscribesPerMinute: 0 } })).toThrow();
  });

  it('enforces the 16 KiB event payload quota', async () => {
    const broker = new MemoryRealtimeBroker();
    await expect(
      broker.publish('tenant-a:orders', 'x'.repeat(16_384)),
    ).rejects.toThrow(/16 KiB/);
    await expect(
      broker.publish('tenant-a:orders', 'x'.repeat(16_000)),
    ).resolves.toMatchObject({ channel: 'tenant-a:orders' });
    await expect(
      broker.publish('tenant-a:orders', { big: 1n }),
    ).rejects.toThrow(/JSON/);
    await expect(broker.publish('Bad Channel', null)).rejects.toThrow();
  });
});

async function app(
  platform: 'express' | 'fastify',
  overrides: Partial<RealtimeModuleOptions> = {},
) {
  const resolve = (user: unknown) => {
    if (user === 'alice') return { binding: alice };
    if (user === 'bob') return { binding: bob };
    if (user === 'carol') return { binding: carol };
    throw new Error('anonymous');
  };
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
        limits: { heartbeatMs: 1000 },
        ...overrides,
      }),
    ],
  }).compile();
  const instance: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await instance.listen(0, '127.0.0.1');
  let closed = false;
  cleanup.push(async () => {
    if (!closed) await instance.close();
  });
  return {
    instance,
    service: instance.get(RealtimeService),
    base: await instance.getUrl(),
    close: async () => {
      closed = true;
      await instance.close();
    },
  };
}
function stream(url: string, headers: Record<string, string>) {
  return new Promise<{
    status: number;
    read: () => string;
    ended: () => boolean;
    close: () => void;
  }>((resolve, reject) => {
    let text = '';
    let ended = false;
    const request = httpRequest(url, { headers }, (response) => {
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      response.on('end', () => {
        ended = true;
      });
      response.on('close', () => {
        ended = true;
      });
      resolve({
        status: response.statusCode ?? 0,
        read: () => text,
        ended: () => ended,
        close: () => request.destroy(),
      });
    });
    request.on('error', (error) => (text ? undefined : reject(error)));
    request.end();
  });
}
async function poll(url: string, user: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      httpRequest(url, { headers: { 'x-user': user } }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(body) as Record<string, unknown>,
          }),
        );
      })
        .on('error', reject)
        .end();
    },
  );
}
function socket(base: string, user: string) {
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/_nestvexa/realtime/ws?as=${user}`,
    { headers: { origin } },
  );
  const messages: Record<string, unknown>[] = [];
  let pings = 0;
  let closed: { code: number; reason: string } | undefined;
  ws.on('message', (data) =>
    messages.push(JSON.parse(String(data)) as Record<string, unknown>),
  );
  ws.on('ping', () => pings++);
  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
  });
  return {
    ws,
    messages,
    pings: () => pings,
    closed: () => closed,
    open: () => new Promise((resolve) => ws.once('open', resolve)),
  };
}

describe.each(['express', 'fastify'] as const)(
  'realtime service on %s',
  (platform) => {
    it('streams SSE heartbeats and closes streams on closeChannel and shutdown', async () => {
      const broker = new MemoryRealtimeBroker();
      let brokerClosed = false;
      const close = broker.close.bind(broker);
      broker.close = async () => {
        brokerClosed = true;
        await close();
      };
      const f = await app(platform, { broker });
      const orders =
        (await f.service.sign({ binding: alice }, ['tenant-a:orders'])) ?? '';
      const invoices =
        (await f.service.sign({ binding: alice }, ['tenant-a:invoices'])) ?? '';
      const first = await stream(
        `${f.base}/_nestvexa/realtime/sse?t=${orders}`,
        { 'x-user': 'alice' },
      );
      const second = await stream(
        `${f.base}/_nestvexa/realtime/sse?t=${invoices}`,
        { 'x-user': 'alice' },
      );
      await until(() => second.read().includes('event: ready'));
      await until(() => first.read().includes(': ping'));
      // Permission change: the host closes every subscription to the channel.
      f.service.closeChannel('tenant-a:orders');
      await until(() => first.read().includes('event: close'));
      expect(first.read()).toContain('"reason":"forbidden"');
      expect(second.read()).not.toContain('event: close');
      expect(f.service.hub.size).toBe(1);
      // Graceful shutdown tells the client why and releases the broker.
      await f.close();
      await until(() => second.read().includes('event: close'));
      expect(second.read()).toContain('"reason":"shutdown"');
      expect(f.service.hub.size).toBe(0);
      expect(brokerClosed).toBe(true);
      expect(broker.subscriptions).toBe(0);
      first.close();
      second.close();
    });

    it('replays missed events after a poll cursor and a WebSocket cursor', async () => {
      const f = await app(platform);
      const detach = await attachRealtimeWebSocket(f.instance);
      cleanup.push(detach);
      const token =
        (await f.service.sign({ binding: alice }, ['tenant-a:feed'])) ?? '';
      const pending = poll(
        `${f.base}/_nestvexa/realtime/poll?t=${token}`,
        'alice',
      );
      await wait(100);
      await f.service.publish('tenant-a:feed', { n: 1 });
      const first = await pending;
      expect(first.body['events']).toMatchObject([{ data: { n: 1 } }]);
      const cursor = String(first.body['cursor']);
      // Events published while no request was open are replayed from the cursor.
      await f.service.publish('tenant-a:feed', { n: 2 });
      await f.service.publish('tenant-a:feed', { n: 3 });
      const replayed = await poll(
        `${f.base}/_nestvexa/realtime/poll?t=${token}&cursor=${cursor}`,
        'alice',
      );
      expect(
        (replayed.body['events'] as { data: unknown }[]).map((e) => e.data),
      ).toEqual([{ n: 2 }, { n: 3 }]);
      const client = socket(f.base, 'alice');
      await client.open();
      client.ws.send(JSON.stringify({ tokens: [token], cursor }));
      await until(() => client.messages.length >= 3);
      // Replayed events may precede the ready notice; both arrive exactly once.
      expect(client.messages.filter((m) => m['type'] === 'ready')).toHaveLength(
        1,
      );
      expect(
        client.messages
          .filter((m) => m['type'] === 'invalidate')
          .map((m) => m['data']),
      ).toEqual([{ n: 2 }, { n: 3 }]);
      // Server heartbeat over WebSocket is a protocol-level ping.
      await until(() => client.pings() > 0, 3000);
      client.ws.close();
    });

    it('closes a WebSocket on token expiry and rejects other tenants', async () => {
      const f = await app(platform);
      const detach = await attachRealtimeWebSocket(f.instance);
      cleanup.push(detach);
      const short = f.service.signer.sign(
        alice,
        ['tenant-a:feed'],
        Date.now() - 899_500,
      );
      const client = socket(f.base, 'alice');
      await client.open();
      client.ws.send(JSON.stringify({ tokens: [short] }));
      await until(() => client.closed() !== undefined, 3000);
      expect(client.closed()).toEqual({ code: 4000, reason: 'expired' });
      const foreign = socket(f.base, 'carol');
      await foreign.open();
      foreign.ws.send(
        JSON.stringify({
          tokens: [f.service.signer.sign(carol, ['tenant-a:feed'])],
        }),
      );
      await until(() => foreign.closed() !== undefined);
      expect(foreign.closed()).toEqual({
        code: 4003,
        reason: 'CHANNEL_FORBIDDEN',
      });
    });

    it('reports presence to authorized readers and rate-limits identity publishes', async () => {
      const f = await app(platform, {
        limits: { heartbeatMs: 1000, publishesPerMinute: 2 },
      });
      const token =
        (await f.service.sign({ binding: bob }, ['tenant-a:room'])) ?? '';
      const sse = await stream(`${f.base}/_nestvexa/realtime/sse?t=${token}`, {
        'x-user': 'bob',
      });
      await until(() => sse.read().includes('event: ready'));
      expect(
        await f.service.presence({ binding: alice }, 'tenant-a:room'),
      ).toMatchObject({ members: [{ id: 'u-bob' }], total: 1 });
      await expect(
        f.service.presence({ binding: carol }, 'tenant-a:room'),
      ).rejects.toMatchObject({ status: 403 });
      sse.close();
      await until(() => f.service.hub.size === 0);
      expect(
        (await f.service.presence({ binding: alice }, 'tenant-a:room')).total,
      ).toBe(0);
      const as = { identity: { binding: alice } };
      await f.service.publish('tenant-a:room', null, as);
      await f.service.publish('tenant-a:room', null, as);
      await expect(
        f.service.publish('tenant-a:room', null, as),
      ).rejects.toMatchObject({ status: 429 });
      // Server-originated publishes (no identity) are not charged.
      await expect(
        f.service.publish('tenant-a:room', null),
      ).resolves.toBeDefined();
      await expect(
        f.service.publish('tenant-a:room', null, {
          identity: { binding: bob },
        }),
      ).resolves.toBeDefined();
    });
  },
);
