import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
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
  MemoryLiveStore,
  State,
  isLiveActionCoordination,
} from '../packages/live/dist/index.js';
import { RedisLiveStore } from '../packages/realtime-redis/dist/index.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const alice = 'tenant-a/session-alice/principal-alice';
const bob = 'tenant-a/session-bob/principal-bob';
const csrf = 'shared-policy-csrf-0123456789abcdefghijkl';
const origin = 'http://127.0.0.1:3421';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const calls = { pay: 0, export: 0 };
let hold: Promise<void> | undefined;

@LiveComponent({ name: 'checkout', view: 'checkout' })
class Checkout {
  @State() charges = 0;
  @Action({ idempotent: true }) pay(): void {
    calls.pay++;
    this.charges++;
  }
  @Action({ concurrency: 'identity' }) async exportAll(): Promise<void> {
    calls.export++;
    const wait = hold;
    hold = undefined;
    await wait;
  }
}

type Platform = 'express' | 'fastify';
async function replica(
  platform: Platform,
  root: string,
  server: RespDouble,
): Promise<{ app: INestApplication; base: string }> {
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const store = new RedisLiveStore({ port: server.port, prefix: 'sp:' });
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Checkout],
        renderer,
        origin,
        store,
        maxRequestsPerMinute: 1_000,
        resolveIdentity: (request: object) => ({
          binding:
            Reflect.get(Reflect.get(request, 'headers') as object, 'x-user') ===
            'bob'
              ? bob
              : alice,
          csrfToken: csrf,
        }),
        authorize: () => true,
      }),
    ],
  }).compile();
  const app: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await app.close();
    await renderer.dispose();
  });
  return { app, base: await app.getUrl() };
}

async function harness(platforms: readonly [Platform, Platform]) {
  calls.pay = 0;
  calls.export = 0;
  hold = undefined;
  const server = await respDouble();
  cleanup.push(() => server.close());
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-shared-policy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'checkout.hbs'), '<p>charges {{charges}}</p>');
  const a = await replica(platforms[0], root, server);
  const b = await replica(platforms[1], root, server);
  const mount = async (user = 'alice') => {
    const html = (
      await a.app
        .get(LiveRuntime)
        .mount(Checkout, { headers: user === 'bob' ? { 'x-user': 'bob' } : {} })
    ).value;
    return /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  };
  const send = async (
    base: string,
    action: string,
    body: Record<string, unknown>,
    user = 'alice',
  ) => {
    const response = await fetch(`${base}/_nestvexa/live/checkout/${action}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        'x-user': user,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const envelope = (snapshot: string, revision: number, requestId: string) => ({
    protocol: 'nestvexa-live/1',
    requestId,
    snapshot,
    revision,
    updates: {},
    input: null,
  });
  return { server, a, b, mount, send, envelope };
}

const pairs = [
  ['express', 'fastify'],
  ['fastify', 'express'],
] as const;

describe('Shared idempotent replay and identity locks (two replicas, RESP test double)', () => {
  it('uses process-local policies unless the store coordinates replicas', () => {
    expect(isLiveActionCoordination(new MemoryLiveStore())).toBe(false);
    expect(isLiveActionCoordination(new RedisLiveStore({ port: 1 }))).toBe(
      true,
    );
    expect(isLiveActionCoordination(null)).toBe(false);
    expect(
      isLiveActionCoordination({ readReplay: () => undefined, writeReplay: 1 }),
    ).toBe(false);
  });

  for (const pair of pairs)
    it(`replays an idempotent retry on the other replica exactly once (${pair.join(' → ')})`, async () => {
      const { server, a, b, mount, send, envelope } = await harness(pair);
      const snapshot = await mount();
      const requestId = randomUUID();
      const first = await send(a.base, 'pay', envelope(snapshot, 0, requestId));
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ state: { charges: 1 } });
      expect(first.body['replayed']).toBeUndefined();
      // The browser lost the response and retries on another replica.
      const retry = await send(b.base, 'pay', envelope(snapshot, 0, requestId));
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({
        replayed: true,
        state: { charges: 1 },
        html: first.body['html'],
        snapshot: first.body['snapshot'],
        component: first.body['component'],
      });
      expect(calls.pay).toBe(1);
      // Same request ID with another payload is a conflict on any replica.
      const reused = await send(
        b.base,
        'pay',
        envelope(snapshot, 1, requestId),
      );
      expect(reused.status).toBe(422);
      expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      // Another identity cannot read the record (and cannot use the state).
      const foreign = await send(
        a.base,
        'pay',
        envelope(snapshot, 0, requestId),
        'bob',
      );
      expect(foreign.status).toBe(410);
      expect(calls.pay).toBe(1);
      // The store holds only digests and ciphertext: no token, HTML or state.
      const stored = [...server.values].map(
        ([key, value]) =>
          `${key}=${typeof value === 'string' ? value : [...value].join(',')}`,
      );
      const records = stored.filter((entry) => entry.startsWith('sp:r:'));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatch(/^sp:r:[A-Za-z0-9_-]{43}=r1\.[A-Za-z0-9_-]+$/);
      for (const entry of stored) {
        expect(entry).not.toContain(snapshot);
        expect(entry).not.toContain(String(first.body['snapshot']));
        expect(entry).not.toContain(requestId);
        expect(entry).not.toContain(alice);
      }
      expect(records[0]).not.toContain('charges');
    }, 60_000);

  it('never replays a tampered or relocated record; the retry fails safely as stale', async () => {
    const { server, a, b, mount, send, envelope } = await harness([
      'express',
      'fastify',
    ]);
    const snapshot = await mount();
    const requestId = randomUUID();
    expect(
      (await send(a.base, 'pay', envelope(snapshot, 0, requestId))).status,
    ).toBe(201);
    const [key, value] = [...server.values].find(([name]) =>
      name.startsWith('sp:r:'),
    ) ?? ['', ''];
    expect(typeof value).toBe('string');
    const text = String(value);
    const flipped = `${text.slice(0, -2)}${text.at(-2) === 'A' ? 'B' : 'A'}${text.at(-1) ?? ''}`;
    server.values.set(key, flipped);
    const tampered = await send(
      b.base,
      'pay',
      envelope(snapshot, 0, requestId),
    );
    expect(tampered.status).toBe(409);
    expect(tampered.body).toMatchObject({ code: 'STALE_REVISION' });
    // A valid record copied under another request's key does not decrypt (AAD).
    server.values.set(key, text);
    const other = randomUUID();
    const second = await send(a.base, 'pay', envelope(snapshot, 1, other));
    expect(second.status).toBe(201);
    const otherKey =
      [...server.values.keys()].find(
        (name) => name.startsWith('sp:r:') && name !== key,
      ) ?? '';
    server.values.set(otherKey, text);
    const relocated = await send(b.base, 'pay', envelope(snapshot, 1, other));
    expect(relocated.status).toBe(409);
    expect(calls.pay).toBe(2);
  }, 60_000);

  for (const pair of pairs)
    it(`excludes an overlapping identity-scoped action across replicas (${pair.join(' → ')})`, async () => {
      const { a, b, mount, send, envelope } = await harness(pair);
      const first = await mount();
      const second = await mount();
      const theirs = await mount('bob');
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = send(
        a.base,
        'exportAll',
        envelope(first, 0, randomUUID()),
      );
      for (let attempt = 0; attempt < 500 && calls.export === 0; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls.export).toBe(1);
      // Another tab of the same identity on the other replica is rejected.
      const busy = await send(
        b.base,
        'exportAll',
        envelope(second, 0, randomUUID()),
      );
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ code: 'ACTION_BUSY' });
      expect(calls.export).toBe(1);
      // The lock is identity-scoped: another user is not blocked.
      const other = await send(
        b.base,
        'exportAll',
        envelope(theirs, 0, randomUUID()),
        'bob',
      );
      expect(other.status).toBe(201);
      expect(calls.export).toBe(2);
      release();
      expect((await running).status).toBe(201);
      // The rejected request kept its state: it runs once the lease is released.
      const after = await send(
        b.base,
        'exportAll',
        envelope(second, 0, randomUUID()),
      );
      expect(after.status).toBe(201);
      expect(calls.export).toBe(3);
    }, 60_000);

  it('expires leases from crashed replicas and releases only the owner’s lease', async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const store = new RedisLiveStore({ port: server.port, prefix: 'sp:' });
    cleanup.push(() => store.close());
    const key = 'k'.repeat(43);
    const ownerA = 'owner-a-0123456789abcdef';
    const ownerB = 'owner-b-0123456789abcdef';
    expect(await store.acquireActionLease(key, ownerA, 100)).toBe(true);
    expect(await store.acquireActionLease(key, ownerB, 100)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await store.acquireActionLease(key, ownerB, 5_000)).toBe(true);
    // The crashed owner's late release must not drop the new owner's lease.
    await store.releaseActionLease(key, ownerA);
    expect(await store.acquireActionLease(key, ownerA, 5_000)).toBe(false);
    await store.releaseActionLease(key, ownerB);
    expect(await store.acquireActionLease(key, ownerA, 5_000)).toBe(true);
    // Keys must be digests and values sealed records.
    await expect(
      store.acquireActionLease('raw identity', ownerA, 100),
    ).rejects.toMatchObject({ code: 'INVALID_STORE_OPTIONS' });
    await expect(store.readReplay('../../x')).rejects.toMatchObject({
      code: 'INVALID_STORE_OPTIONS',
    });
    await expect(
      store.writeReplay(key, '{"plain":"json"}', 1_000),
    ).rejects.toMatchObject({ code: 'INVALID_STORE_OPTIONS' });
    await expect(
      store.acquireActionLease(key, 'short', 1_000),
    ).rejects.toMatchObject({ code: 'INVALID_STORE_OPTIONS' });
    await store.writeReplay(key, 'r1.sealed-value', 100);
    expect(await store.readReplay(key)).toBe('r1.sealed-value');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await store.readReplay(key)).toBeUndefined();
  });
});
