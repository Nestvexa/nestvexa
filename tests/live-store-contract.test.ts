import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
} from '../packages/live/dist/index.js';
import type {
  LiveStateStore,
  StateSnapshot,
} from '../packages/live/dist/index.js';
import { liveStoreContract } from '../packages/live/dist/testing.js';
import type { LiveStoreContractHarness } from '../packages/live/dist/testing.js';
import { RedisLiveStore } from '../packages/realtime-redis/dist/index.js';
import { SqliteLiveStore } from '../examples/data-cache/dist/sqlite-live-store.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const alice = 'tenant-a/session-alice/principal-alice';
const bob = 'tenant-a/session-bob/principal-bob';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Host-side namespace: bindings are `<tenant>/<session>/<principal>`. */
const namespace = (binding: string) => {
  const [tenant = '', , user] = binding.split('/');
  return { tenant, ...(user === undefined ? {} : { user }) };
};
const memory = (): LiveStoreContractHarness => {
  let now = 1_000_000;
  return {
    shared: false,
    // MemoryLiveStore bounds total entries, not entries per binding.
    boundsEntriesPerBinding: false,
    advance: (ms) => {
      now += ms;
    },
    store: (options) =>
      new MemoryLiveStore({
        now: () => now,
        ttlMs: options.ttlMs,
        ...(options.maxEntries === undefined
          ? {}
          : { maxEntries: options.maxEntries }),
      }),
  };
};
const redis =
  (namespaced: boolean) => async (): Promise<LiveStoreContractHarness> => {
    const server = await respDouble();
    let now = 1_000_000;
    const prefix = 'contract' + randomBytes(3).toString('hex') + ':';
    return {
      shared: true,
      boundsEntriesPerBinding: true,
      advance: (ms) => {
        now += ms;
      },
      store: (options) =>
        new RedisLiveStore({
          port: server.port,
          prefix,
          now: () => now,
          ttlMs: options.ttlMs,
          ...(namespaced ? { namespace } : {}),
          ...(options.maxEntries === undefined
            ? {}
            : { maxEntriesPerBinding: options.maxEntries }),
        }),
      dispose: () => server.close(),
    };
  };
const sqlite = async (): Promise<LiveStoreContractHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-sqlite-store-'));
  let now = 1_000_000;
  return {
    shared: true,
    boundsEntriesPerBinding: true,
    advance: (ms) => {
      now += ms;
    },
    store: (options) =>
      new SqliteLiveStore({
        path: join(root, 'live.db'),
        now: () => now,
        ttlMs: options.ttlMs,
        ...(options.maxEntries === undefined
          ? {}
          : { maxEntriesPerBinding: options.maxEntries }),
      }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
};

describe.each([
  ['MemoryLiveStore', memory],
  ['RedisLiveStore (RESP test double)', redis(false)],
  ['RedisLiveStore with tenant/user namespace (RESP test double)', redis(true)],
  ['SqliteLiveStore (examples/data-cache custom store)', sqlite],
] as const)('Live state store contract: %s', (_name, factory) => {
  for (const contract of liveStoreContract(factory))
    it(contract.name, () => contract.run());
});

describe('liveStoreContract catches broken stores', () => {
  it('fails a store that ignores revision locks and replays', async () => {
    // Runs every transaction against the current revision instead of the requested one.
    class Lenient extends MemoryLiveStore {
      override async transaction(
        token: string,
        binding: string,
        _revision: number,
        callback: Parameters<LiveStateStore['transaction']>[3],
      ) {
        const current = this.peek(token, binding);
        return super.transaction(token, binding, current.revision, callback);
      }
    }
    const harness = (): LiveStoreContractHarness => ({
      shared: false,
      boundsEntriesPerBinding: false,
      advance: () => undefined,
      store: () => new Lenient(),
    });
    const stale = liveStoreContract(harness).find((entry) =>
      entry.name.startsWith('commits revision + 1'),
    );
    await expect(stale?.run()).rejects.toThrow(/revision 0/);
  });
  it('fails a store whose peek ignores the binding', async () => {
    class Unbound extends MemoryLiveStore {
      readonly #owners = new Map<string, string>();
      override create(...args: Parameters<MemoryLiveStore['create']>) {
        const created = super.create(...args);
        this.#owners.set(created.snapshot, args[1]);
        return created;
      }
      override peek(token: string, binding: string) {
        return super.peek(token, this.#owners.get(token) ?? binding);
      }
    }
    const harness = (): LiveStoreContractHarness => ({
      shared: false,
      boundsEntriesPerBinding: false,
      advance: () => undefined,
      store: () => new Unbound(),
    });
    const binding = liveStoreContract(harness).find((entry) =>
      entry.name.startsWith('creates detached frozen snapshots'),
    );
    await expect(binding?.run()).rejects.toThrow(/foreign binding/);
  });
});

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
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('RedisLiveStore tenant/user namespacing (DATA-004, RESP test double)', () => {
  async function setup() {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const store = new RedisLiveStore({
      port: server.port,
      prefix: 'ns:',
      namespace,
    });
    cleanup.push(() => store.close());
    return { server, store };
  }
  const aliceSecond = 'tenant-a/session-alice-2/principal-alice';
  const carol = 'tenant-b/session-carol/principal-carol';

  it('keeps every key of a tenant under its own namespace with hashed users and tokens', async () => {
    const { server, store } = await setup();
    const a = await store.create('counter', alice, { n: 1 });
    const c = await store.create('counter', carol, { n: 2 });
    await store.transaction(a.snapshot, alice, 0, (s) => commit(s.state));
    const keys = [...server.values.keys()];
    const tokenA = sha(a.snapshot);
    const tokenC = sha(c.snapshot);
    expect(keys).toContain(`ns:t:tenant-a:s:${tokenA}`);
    expect(keys).toContain(`ns:t:tenant-b:s:${tokenC}`);
    expect(keys).toContain(`ns:t:tenant-a:b:${sha(alice)}`);
    expect(keys).toContain(`ns:t:tenant-a:u:${sha('principal-alice')}`);
    expect(keys).toContain('ns:t:tenant-a:i');
    expect(server.values.get(`ns:p:${tokenA}`)).toBe('tenant-a');
    // Only tenant ids appear in clear; tokens, bindings and users are hashed.
    const text =
      keys.join('\n') +
      [...server.values.values()]
        .map((value) => (typeof value === 'string' ? value : ''))
        .join('\n');
    for (const secret of [a.snapshot, alice, 'principal-alice', carol])
      expect(text).not.toContain(secret);
    // Lease and fence keys are gone after a commit.
    expect(keys.some((key) => /:(?:l|f):/.test(key))).toBe(false);
    // Nothing outside the tenant namespaces except the delete pointers.
    expect(
      keys.filter((key) => !/^ns:(?:t:tenant-[ab]:|p:)/.test(key)),
    ).toEqual([]);
  });

  it('refuses a record moved into another tenant namespace or with a rewritten tenant', async () => {
    const { server, store } = await setup();
    const a = await store.create('counter', alice, { n: 1 });
    const tokenA = sha(a.snapshot);
    const record = String(server.values.get(`ns:t:tenant-a:s:${tokenA}`));
    // The same session/principal under tenant-b resolves to tenant-b keys.
    server.values.set(`ns:t:tenant-b:s:${tokenA}`, record);
    const moved = 'tenant-b/session-alice/principal-alice';
    expect(await code(() => store.peek(a.snapshot, moved))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    server.values.set(
      `ns:t:tenant-a:s:${tokenA}`,
      record.replace('"t":"tenant-a"', '"t":"tenant-b"'),
    );
    expect(await code(() => store.peek(a.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
  });

  it('revokes one user across sessions, then a whole tenant, and nothing else', async () => {
    const { server, store } = await setup();
    const first = await store.create('counter', alice, {});
    const second = await store.create('counter', aliceSecond, {});
    const other = await store.create('counter', bob, {});
    const foreign = await store.create('counter', carol, {});
    expect(await store.revokeUser('tenant-a', 'principal-alice')).toBe(2);
    expect(await code(() => store.peek(first.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    expect(await code(() => store.peek(second.snapshot, aliceSecond))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    expect((await store.peek(other.snapshot, bob)).revision).toBe(0);
    // Bulk tenant revocation runs in rounds (more bindings than one batch).
    const many = [];
    for (let index = 0; index < 70; index++)
      many.push(
        await store.create(
          'counter',
          `tenant-a/session-${index}/principal-x`,
          {},
        ),
      );
    // Bob plus the 70 sessions: Alice's revoked sessions are not counted again.
    expect(await store.revokeTenant('tenant-a')).toBe(71);
    expect(await code(() => store.peek(other.snapshot, bob))).toBe(
      'INVALID_SNAPSHOT:410',
    );
    expect(
      await code(() =>
        store.peek(many[69]?.snapshot ?? '', 'tenant-a/session-69/principal-x'),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
    expect((await store.peek(foreign.snapshot, carol)).revision).toBe(0);
    // No key of tenant-a survives (entries, indexes, user indexes).
    expect(
      [...server.values.keys()].filter((key) =>
        key.startsWith('ns:t:tenant-a:'),
      ),
    ).toEqual([]);
    expect(await store.revokeTenant('tenant-a')).toBe(0);
    // Host-only delete finds a namespaced entry through its pointer.
    expect(await store.delete(foreign.snapshot)).toBe(true);
    expect(await store.delete(foreign.snapshot)).toBe(false);
  });

  it('validates the namespace and refuses tenant operations without it', async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const plain = new RedisLiveStore({ port: server.port });
    cleanup.push(() => plain.close());
    expect(await code(() => plain.revokeTenant('tenant-a'))).toBe(
      'INVALID_STORE_OPTIONS:500',
    );
    expect(await code(() => plain.revokeUser('tenant-a', 'u'))).toBe(
      'INVALID_STORE_OPTIONS:500',
    );
    for (const bad of [
      () => ({ tenant: 'has:colon' }),
      () => ({ tenant: '' }),
      () => ({ tenant: 'ok', user: '' }),
      () => null,
    ]) {
      const store = new RedisLiveStore({
        port: server.port,
        namespace: bad as () => { tenant: string },
      });
      cleanup.push(() => store.close());
      expect(await code(() => store.create('counter', alice, {}))).toBe(
        'INVALID_STORE_OPTIONS:500',
      );
    }
    expect(
      () => new RedisLiveStore({ namespace: 'x' as unknown as () => never }),
    ).toThrow(/namespace/);
  });
});

describe('RedisLiveStore failure behaviour (DATA-004, RESP test double)', () => {
  it('invalidates an entry whose earlier attempt never recorded a commit (fence)', async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const store = new RedisLiveStore({ port: server.port, prefix: 'f:' });
    cleanup.push(() => store.close());
    const created = await store.create('counter', alice, { count: 0 });
    // A replica crashed (or lost Redis) after starting the callback: its fence remains.
    server.values.set(`f:f:${sha(created.snapshot)}`, '0');
    let ran = false;
    expect(
      await code(() =>
        store.transaction(created.snapshot, alice, 0, async (s) => {
          ran = true;
          return commit(s.state);
        }),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
    expect(ran).toBe(false);
    expect(await code(() => store.peek(created.snapshot, alice))).toBe(
      'INVALID_SNAPSHOT:410',
    );
  });

  it('a lapsed lease lets the next attempt invalidate instead of running the callback twice', async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const options = { port: server.port, prefix: 'lap:', lockTtlMs: 100 };
    const a = new RedisLiveStore(options);
    const b = new RedisLiveStore(options);
    cleanup.push(
      () => a.close(),
      () => b.close(),
    );
    const created = await a.create('counter', alice, { count: 0 });
    let calls = 0;
    const slow = a.transaction(created.snapshot, alice, 0, async (s) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return commit(s.state);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The lease lapsed while the first callback still runs.
    expect(
      await code(() =>
        b.transaction(created.snapshot, alice, 0, async (s) => {
          calls++;
          return commit(s.state);
        }),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
    expect(await code(() => slow)).toBe('INVALID_SNAPSHOT:410');
    expect(calls).toBe(1);
  });

  it('reports an outage during commit as 503 STORE_UNAVAILABLE and never re-runs the callback afterwards', async () => {
    const server = await respDouble();
    const port = server.port;
    const store = new RedisLiveStore({ port, prefix: 'out:' });
    cleanup.push(() => store.close());
    const created = await store.create('counter', alice, { count: 0 });
    let calls = 0;
    const outcome = await code(() =>
      store.transaction(created.snapshot, alice, 0, async (s) => {
        calls++;
        await server.close();
        return commit(s.state);
      }),
    );
    expect(outcome).toBe('STORE_UNAVAILABLE:503');
    expect(await code(() => store.peek(created.snapshot, alice))).toBe(
      'STORE_UNAVAILABLE:503',
    );
    // Redis comes back with its data (state and fence); the lease has expired.
    const restarted = await respDouble({ port });
    cleanup.push(() => restarted.close());
    for (const [key, value] of server.values)
      if (!key.startsWith('out:l:')) restarted.values.set(key, value);
    expect((await store.peek(created.snapshot, alice)).revision).toBe(0);
    expect(
      await code(() =>
        store.transaction(created.snapshot, alice, 0, async (s) => {
          calls++;
          return commit(s.state);
        }),
      ),
    ).toBe('INVALID_SNAPSHOT:410');
    expect(calls).toBe(1);
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
    const failure: unknown = await store
      .peek(created.snapshot, alice)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LiveProtocolError);
    expect(failure).toMatchObject({ code: 'STORE_UNAVAILABLE', status: 503 });
    // The underlying I/O error stays available to host logs.
    expect(String(Reflect.get(failure as object, 'cause'))).toMatch(
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
  }, 60_000);
});
