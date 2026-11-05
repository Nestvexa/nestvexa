import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveProtocolError,
  LiveRuntime,
  MemoryLiveStore,
  State,
  isLiveStateStore,
} from '../packages/live/dist/index.js';
import type {
  LiveStateStore,
  StateSnapshot,
} from '../packages/live/dist/index.js';
import { RedisLiveStore } from '../packages/realtime-redis/dist/index.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const alice = 'tenant-a/session-alice/principal-alice';
const bob = 'tenant-a/session-bob/principal-bob';
const otherTenant = 'tenant-b/session-alice/principal-alice';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Clock {
  now: number;
}
interface Harness {
  /** A store; calling twice with the same harness gives a second replica where supported. */
  store(options?: {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  }): LiveStateStore;
  readonly clock: Clock;
  readonly shared: boolean;
}
type Factory = () => Promise<Harness>;

const memory: Factory = async () => {
  const clock = { now: 1_000_000 };
  return {
    clock,
    shared: false,
    store: (options = {}) => {
      const store = new MemoryLiveStore({
        now: () => clock.now,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
        ...(options.maxEntries === undefined
          ? {}
          : { maxEntries: options.maxEntries }),
      });
      cleanup.push(() => store.close());
      return store;
    },
  };
};
const redis: Factory = async () => {
  const server = await respDouble();
  cleanup.push(() => server.close());
  const clock = { now: 1_000_000 };
  const prefix = 'contract' + randomBytes(3).toString('hex') + ':';
  return {
    clock,
    shared: true,
    store: (options = {}) => {
      const store = new RedisLiveStore({
        port: server.port,
        prefix,
        now: () => clock.now,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
        ...(options.maxEntries === undefined
          ? {}
          : { maxEntriesPerBinding: options.maxEntries }),
      });
      cleanup.push(() => store.close());
      return store;
    },
  };
};

async function code(promise: unknown): Promise<string> {
  try {
    await (typeof promise === 'function'
      ? (promise as () => unknown)()
      : promise);
  } catch (error) {
    if (error instanceof LiveProtocolError)
      return `${error.code}:${error.status}`;
    throw error;
  }
  return 'ok';
}
const commit = (state: StateSnapshot['state'], html = '<p>ok</p>') =>
  Promise.resolve({ state: { ...state }, html });

describe.each([
  ['MemoryLiveStore', memory],
  ['RedisLiveStore (RESP test double)', redis],
] as const)('Live state store contract: %s', (_name, factory) => {
  it('satisfies the structural interface the runtime accepts', async () => {
    const f = await factory();
    expect(isLiveStateStore(f.store())).toBe(true);
    expect(isLiveStateStore({ create() {}, peek() {} })).toBe(false);
  });

  it('creates detached frozen snapshots and reads them back only for the same binding', async () => {
    const f = await factory();
    const store = f.store();
    const input = { count: 1, tags: ['a'], nested: { ok: true } };
    const created = await store.create('counter', alice, input);
    input.count = 99;
    expect(created).toMatchObject({
      name: 'counter',
      revision: 0,
      state: { count: 1, tags: ['a'], nested: { ok: true } },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.snapshot).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.isFrozen(created.state)).toBe(true);
    const read = await store.peek(created.snapshot, alice);
    expect(read.state).toEqual(created.state);
    expect(read.expiresAt).toBe(created.expiresAt);
    // Foreign bindings, unknown and malformed tokens fail identically.
    const unknown = randomBytes(32).toString('base64url');
    for (const attempt of [
      () => store.peek(created.snapshot, bob),
      () => store.peek(created.snapshot, otherTenant),
      () => store.peek(unknown, alice),
      () => store.peek('not-a-token', alice),
      () => store.peek(created.snapshot, ''),
    ])
      expect(await code(attempt)).toBe('INVALID_SNAPSHOT:410');
  });

  it('rejects invalid component names and non-JSON state before storing', async () => {
    const f = await factory();
    const store = f.store();
    expect(await code(() => store.create('Bad Name', alice, {}))).toBe(
      'INVALID_STATE:400',
    );
    expect(
      await code(() => store.create('counter', alice, { value: Number.NaN })),
    ).toBe('INVALID_REQUEST:400');
    expect(
      await code(() =>
        store.create('counter', alice, JSON.parse('{"__proto__":{"x":1}}')),
      ),
    ).toBe('INVALID_REQUEST:400');
  });

  it('commits revision + 1 and rejects stale or replayed revisions before running the callback', async () => {
    const f = await factory();
    const store = f.store();
    const created = await store.create('counter', alice, { count: 0 });
    const result = await store.transaction(
      created.snapshot,
      alice,
      0,
      async (snapshot) => {
        expect(Object.isFrozen(snapshot.state)).toBe(true);
        return commit({ count: Number(snapshot.state['count']) + 1 });
      },
    );
    expect(result).toMatchObject({
      revision: 1,
      state: { count: 1 },
      html: '<p>ok</p>',
      snapshot: created.snapshot,
      id: created.id,
    });
    expect((await store.peek(created.snapshot, alice)).revision).toBe(1);
    let calls = 0;
    const counted = async (snapshot: StateSnapshot) => {
      calls++;
      return commit(snapshot.state);
    };
    // Replay of the request that produced revision 1.
    for (const revision of [0, 2, -1, 1.5, Number.MAX_SAFE_INTEGER])
      expect(
        await code(() =>
          store.transaction(created.snapshot, alice, revision, counted),
        ),
      ).toBe('STALE_REVISION:409');
    expect(
      await code(() => store.transaction(created.snapshot, bob, 1, counted)),
    ).toBe('INVALID_SNAPSHOT:410');
    expect(calls).toBe(0);
    expect((await store.peek(created.snapshot, alice)).revision).toBe(1);
  });

  it('serializes concurrent transactions on one entry (COMPONENT_BUSY)', async () => {
    const f = await factory();
    const store = f.store();
    const created = await store.create('counter', alice, { count: 0 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.transaction(
      created.snapshot,
      alice,
      0,
      async (snapshot) => {
        await gate;
        return commit({ count: Number(snapshot.state['count']) + 1 });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    let ran = false;
    expect(
      await code(() =>
        store.transaction(created.snapshot, alice, 0, async (snapshot) => {
          ran = true;
          return commit(snapshot.state);
        }),
      ),
    ).toBe('COMPONENT_BUSY:409');
    release();
    expect((await first).revision).toBe(1);
    expect(ran).toBe(false);
    // The lock is released after commit.
    expect(
      (
        await store.transaction(created.snapshot, alice, 1, async (snapshot) =>
          commit(snapshot.state),
        )
      ).revision,
    ).toBe(2);
  });

  it('invalidates the entry when the callback fails instead of permitting a retry', async () => {
    const f = await factory();
    const store = f.store();
    const created = await store.create('counter', alice, { count: 0 });
    await expect(
      store.transaction(created.snapshot, alice, 0, async () => {
        throw new Error('side effect may have happened');
      }),
    ).rejects.toThrow('side effect may have happened');
    expect(await code(() => store.peek(created.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    const big = await store.create('counter', alice, { count: 0 });
    expect(
      await code(() =>
        store.transaction(big.snapshot, alice, 0, async (snapshot) =>
          commit(snapshot.state, 'x'.repeat(1_048_577)),
        ),
      ),
    ).toBe('PAYLOAD_TOO_LARGE:413');
    expect(await code(() => store.peek(big.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
  });

  it('never resurrects state revoked, deleted or expired during a transaction', async () => {
    const f = await factory();
    const store = f.store({ ttlMs: 60_000 });
    for (const interrupt of ['revoke', 'delete', 'expire'] as const) {
      const created = await store.create('counter', alice, { count: 0 });
      const outcome = await code(() =>
        store.transaction(created.snapshot, alice, 0, async () => {
          if (interrupt === 'revoke') await store.revoke(alice);
          else if (interrupt === 'delete') await store.delete(created.snapshot);
          else f.clock.now += 60_001;
          return commit({ count: 5 });
        }),
      );
      expect(outcome, interrupt).toBe('INVALID_SNAPSHOT:410');
      expect(await code(() => store.peek(created.snapshot, alice))).toBe(
        'INVALID_SNAPSHOT:410',
      );
    }
  });

  it('expires entries after the TTL', async () => {
    const f = await factory();
    const store = f.store({ ttlMs: 1000 });
    const created = await store.create('counter', alice, { count: 0 });
    f.clock.now += 999;
    expect((await store.peek(created.snapshot, alice)).revision).toBe(0);
    f.clock.now += 1;
    expect(await code(() => store.peek(created.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    expect(
      await code(() =>
        store.transaction(created.snapshot, alice, 0, async (snapshot) =>
          commit(snapshot.state),
        ),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
  });

  it('revokes every entry of one binding and nothing else', async () => {
    const f = await factory();
    const store = f.store();
    const a1 = await store.create('counter', alice, { n: 1 });
    const a2 = await store.create('editor', alice, { n: 2 });
    const b1 = await store.create('counter', bob, { n: 3 });
    const t1 = await store.create('counter', otherTenant, { n: 4 });
    await store.revoke(alice);
    for (const token of [a1.snapshot, a2.snapshot])
      expect(await code(() => store.peek(token, alice))).toBe(
        'INVALID_SNAPSHOT:410',
      );
    expect((await store.peek(b1.snapshot, bob)).state).toEqual({ n: 3 });
    expect((await store.peek(t1.snapshot, otherTenant)).state).toEqual({
      n: 4,
    });
    expect(await store.delete(b1.snapshot)).toBe(true);
    expect(await store.delete(b1.snapshot)).toBe(false);
    expect(await store.delete('malformed')).toBe(false);
  });

  it('keeps child references across commits unless the callback replaces them', async () => {
    const f = await factory();
    const store = f.store();
    const child = await store.create('row', alice, { label: 'a' });
    const parent = await store.create(
      'board',
      alice,
      { rows: 1 },
      {
        first: {
          alias: 'row',
          name: 'row',
          id: child.id,
          token: child.snapshot,
        },
      },
    );
    expect(parent.children?.['first']?.token).toBe(child.snapshot);
    const kept = await store.transaction(
      parent.snapshot,
      alice,
      0,
      async (snapshot) => commit(snapshot.state),
    );
    expect(kept.children?.['first']?.id).toBe(child.id);
    const replaced = await store.transaction(
      parent.snapshot,
      alice,
      1,
      async (snapshot) => ({
        state: { ...snapshot.state },
        html: '',
        children: {},
      }),
    );
    expect(replaced.children).toEqual({});
    expect((await store.peek(parent.snapshot, alice)).children).toEqual({});
  });

  it('bounds the entries one binding can hold', async () => {
    const f = await factory();
    const store = f.store({ maxEntries: 2 });
    await store.create('counter', alice, {});
    await store.create('counter', alice, {});
    expect(await code(() => store.create('counter', alice, {}))).toBe(
      'STORE_CAPACITY:503',
    );
  });

  it('shares state and locks between replicas when the store is shared', async () => {
    const f = await factory();
    if (!f.shared) {
      // Process-local by design: a second instance never sees the entry.
      const a = f.store();
      const b = f.store();
      const created = await a.create('counter', alice, { count: 0 });
      expect(await code(() => b.peek(created.snapshot, alice))).toBe(
        'INVALID_SNAPSHOT:410',
      );
      return;
    }
    const a = f.store();
    const b = f.store();
    const created = await a.create('counter', alice, { count: 0 });
    const continued = await b.transaction(
      created.snapshot,
      alice,
      0,
      async (snapshot) =>
        commit({ count: Number(snapshot.state['count']) + 1 }),
    );
    expect(continued.state).toEqual({ count: 1 });
    expect((await a.peek(created.snapshot, alice)).revision).toBe(1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onA = a.transaction(created.snapshot, alice, 1, async (snapshot) => {
      await gate;
      return commit(snapshot.state);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      await code(() =>
        b.transaction(created.snapshot, alice, 1, async (snapshot) =>
          commit(snapshot.state),
        ),
      ),
    ).toBe('COMPONENT_BUSY:409');
    release();
    await onA;
    // Replaying revision 1 on the other replica is rejected.
    expect(
      await code(() =>
        b.transaction(created.snapshot, alice, 1, async (snapshot) =>
          commit(snapshot.state),
        ),
      ),
    ).toBe('STALE_REVISION:409');
    await b.revoke(alice);
    expect(await code(() => a.peek(created.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
  });
});

describe('RedisLiveStore storage hardening (RESP test double)', () => {
  async function setup(
    options: ConstructorParameters<typeof RedisLiveStore>[0] = {},
  ) {
    const server = await respDouble({ password: 'store-password-123' });
    cleanup.push(() => server.close());
    const store = new RedisLiveStore({
      port: server.port,
      password: 'store-password-123',
      prefix: 'hard:',
      ...options,
    });
    cleanup.push(() => store.close());
    return { server, store };
  }
  const stateKeys = (server: RespDouble) =>
    [...server.values.keys()].filter((key) => key.startsWith('hard:s:'));

  it('keys entries by token and binding hashes, never raw tokens or bindings', async () => {
    const { server, store } = await setup();
    const created = await store.create('counter', alice, { secret: 'public' });
    const keys = [...server.values.keys()].join('\n');
    expect(keys).not.toContain(created.snapshot);
    expect(keys).not.toContain(alice);
    const stored = String(server.values.get(stateKeys(server)[0] ?? ''));
    expect(stored).not.toContain(created.snapshot);
    expect(stored).not.toContain(alice);
    expect(server.log).toContain('AUTH');
  });

  it('treats tampered or foreign records as unavailable state', async () => {
    const { server, store } = await setup();
    for (const forged of [
      'not json',
      '{"v":1,"i":"x"}',
      '{"v":1,"i":"00000000-0000-4000-8000-000000000000","n":"counter","r":0,"e":9007199254740000,"b":"' +
        'a'.repeat(64) +
        '","s":{"__proto__":{"admin":true}}}',
      '[]',
    ]) {
      const created = await store.create('counter', alice, { n: 1 });
      const [key] = stateKeys(server);
      if (!key) throw new Error('missing key');
      server.values.set(key, forged);
      expect(await code(() => store.peek(created.snapshot, alice))).toBe(
        'INVALID_SNAPSHOT:410',
      );
      server.values.delete(key);
    }
  });

  it('encrypts records at rest when keys are configured and rejects downgrades and swaps', async () => {
    const key = randomBytes(32);
    const { server, store } = await setup({ encryptionKeys: [key] });
    const created = await store.create('counter', alice, {
      marker: 'visible-only-after-decryption',
    });
    const [stored] = stateKeys(server);
    const raw = String(server.values.get(stored ?? ''));
    expect(raw).toMatch(/^e1\./);
    expect(raw).not.toContain('visible-only-after-decryption');
    expect((await store.peek(created.snapshot, alice)).state).toEqual({
      marker: 'visible-only-after-decryption',
    });
    // A ciphertext moved to another entry's key fails authentication.
    const other = await store.create('counter', alice, { marker: 'other' });
    const otherKey = stateKeys(server).find(
      (candidate) => candidate !== stored,
    );
    server.values.set(otherKey ?? '', raw);
    expect(await code(() => store.peek(other.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    // Rotation: a store with a new first key still reads old records.
    const rotated = new RedisLiveStore({
      port: server.port,
      password: 'store-password-123',
      prefix: 'hard:',
      encryptionKeys: [randomBytes(32), key],
    });
    cleanup.push(() => rotated.close());
    expect((await rotated.peek(created.snapshot, alice)).state).toEqual({
      marker: 'visible-only-after-decryption',
    });
    // A plaintext store cannot read encrypted records, and vice versa.
    const plain = new RedisLiveStore({
      port: server.port,
      password: 'store-password-123',
      prefix: 'hard:',
    });
    cleanup.push(() => plain.close());
    expect(await code(() => plain.peek(created.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    const plainEntry = await plain.create('counter', alice, { n: 1 });
    expect(await code(() => store.peek(plainEntry.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
  });

  it('rejects wrong credentials and invalid options', async () => {
    const server = await respDouble({ password: 'right-password-1' });
    cleanup.push(() => server.close());
    const store = new RedisLiveStore({
      port: server.port,
      password: 'wrong-password-1',
    });
    cleanup.push(() => store.close());
    await expect(store.create('counter', alice, {})).rejects.toThrow();
    for (const options of [
      { prefix: 'Bad Prefix' },
      { ttlMs: 0 },
      { lockTtlMs: 10 },
      { maxEntriesPerBinding: 0 },
      { encryptionKeys: [randomBytes(16)] },
      { port: 0 },
    ])
      expect(() => new RedisLiveStore(options)).toThrow();
  });

  it('expires the transaction lease so a crashed replica cannot block an entry forever', async () => {
    const { store } = await setup({ lockTtlMs: 100 });
    const created = await store.create('counter', alice, { count: 0 });
    // A transaction whose callback outlives its lease cannot commit.
    expect(
      await code(() =>
        store.transaction(created.snapshot, alice, 0, async (snapshot) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return commit(snapshot.state);
        }),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
    const fresh = await store.create('counter', alice, { count: 0 });
    expect(
      (
        await store.transaction(fresh.snapshot, alice, 0, async (snapshot) =>
          commit(snapshot.state),
        )
      ).revision,
    ).toBe(1);
  });

  it('surfaces a broker outage as an error, not as missing state', async () => {
    const { server, store } = await setup();
    const created = await store.create('counter', alice, { count: 0 });
    await server.close();
    await expect(store.peek(created.snapshot, alice)).rejects.toThrow(
      /Redis connection/,
    );
  });
});

describe('LiveRuntime with a shared store (two Nest applications, RESP test double)', () => {
  it('continues on replica B an action whose state replica A created, and rejects replays and foreign identities', async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-shared-store-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'tally.hbs'), '<p>{{count}}</p>');
    @LiveComponent({ name: 'tally', view: 'tally' })
    class Tally {
      @State() count = 0;
      @Action() increment(): void {
        this.count++;
      }
    }
    const csrf = 'shared-store-csrf-0123456789abcdefghijkl';
    const origin = 'http://127.0.0.1:3999';
    async function replica() {
      const renderer = new HbsEngine({ root });
      await renderer.initialize();
      const store = new RedisLiveStore({ port: server.port, prefix: 'rt:' });
      const module = await Test.createTestingModule({
        imports: [
          LiveModule.register({
            components: [Tally],
            renderer,
            origin,
            store,
            resolveIdentity: (request: object) => {
              const user: unknown = Reflect.get(
                Reflect.get(request, 'headers') as object,
                'x-user',
              );
              return {
                binding: user === 'bob' ? bob : alice,
                csrfToken: csrf,
              };
            },
            authorize: () => true,
          }),
        ],
      }).compile();
      const app: INestApplication = module.createNestApplication({
        logger: false,
      });
      await app.listen(0, '127.0.0.1');
      cleanup.push(async () => {
        await app.close();
        await renderer.dispose();
      });
      return { app, base: await app.getUrl() };
    }
    const a = await replica();
    const b = await replica();
    expect(a.app.get(LiveRuntime).store).toBeInstanceOf(RedisLiveStore);
    const html = (await a.app.get(LiveRuntime).mount(Tally, { headers: {} }))
      .value;
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
    const send = async (base: string, revision: number, user = 'alice') => {
      const response = await fetch(`${base}/_nestvexa/live/tally/increment`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': csrf,
          'x-user': user,
        },
        body: JSON.stringify({
          protocol: 'nestvexa-live/1',
          requestId: randomUUID(),
          snapshot,
          revision,
          updates: {},
          input: null,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const onB = await send(b.base, 0);
    expect(onB.body).toMatchObject({ state: { count: 1 }, html: '<p>1</p>' });
    expect(onB.body['component']).toMatchObject({ revision: 1 });
    // Replaying revision 0 on either replica is a conflict, not a second increment.
    expect((await send(a.base, 0)).status).toBe(409);
    expect((await send(b.base, 0)).status).toBe(409);
    // Another identity cannot continue the state on any replica.
    expect((await send(a.base, 1, 'bob')).status).toBe(410);
    expect((await send(a.base, 1)).body).toMatchObject({ state: { count: 2 } });
    // Shutting a replica down closes its connections but keeps shared state.
    await a.app.close();
    expect((await send(b.base, 2)).body).toMatchObject({ state: { count: 3 } });
  });
});
