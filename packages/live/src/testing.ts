import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LiveProtocolError, type JsonValue } from './protocol.js';
import {
  isLiveStateStore,
  type LiveStateStore,
  type LiveTransactionCommit,
  type StateSnapshot,
} from './store.js';

/**
 * What the Live state store contract suite needs from a store under test.
 * The store must read time from the harness clock (for TTL checks).
 */
export interface LiveStoreContractHarness {
  /**
   * A new store instance. When `shared` is true, every instance created by one
   * harness must see the same entries (replicas on one backend).
   */
  store(options: {
    readonly ttlMs: number;
    readonly maxEntries?: number;
  }): LiveStateStore | Promise<LiveStateStore>;
  /** Advance the clock the stores read by `ms` milliseconds. */
  advance(ms: number): void;
  /** Instances share entries and locks (Redis, SQL); false for process-local stores. */
  readonly shared: boolean;
  /**
   * `maxEntries` bounds the entries one binding may hold (true), or the store
   * has no per-binding bound (false: the capacity case is skipped).
   */
  readonly boundsEntriesPerBinding: boolean;
  /** Release the backend after a case (stores are already closed). */
  dispose?(): void | Promise<void>;
}
export interface LiveStoreContractCase {
  readonly name: string;
  run(): Promise<void>;
}

const alice = 'tenant-a/session-alice/principal-alice';
const bob = 'tenant-a/session-bob/principal-bob';
const otherTenant = 'tenant-b/session-alice/principal-alice';

/** `CODE:status` of a LiveProtocolError, or `ok`; other errors propagate. */
async function outcome(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof LiveProtocolError)
      return `${error.code}:${error.status}`;
    throw error;
  }
  return 'ok';
}
function commit(
  state: StateSnapshot['state'],
  html = '<p>ok</p>',
): Promise<LiveTransactionCommit> {
  return Promise.resolve({ state: { ...state }, html });
}
function count(snapshot: StateSnapshot): number {
  const value: JsonValue | undefined = snapshot.state['count'];
  return typeof value === 'number' ? value : Number.NaN;
}
function gate(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
/** Plain JSON copy: stores may return null-prototype objects. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type Body = (
  store: (options?: {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  }) => Promise<LiveStateStore>,
  harness: LiveStoreContractHarness,
) => Promise<void>;

/**
 * Reusable conformance suite for custom `LiveStateStore` implementations
 * (the same checks `MemoryLiveStore` and `RedisLiveStore` pass). It has no
 * test-framework dependency: register each case with your runner, for example
 * `for (const c of liveStoreContract(factory)) it(c.name, () => c.run())`.
 * A failing case throws an `AssertionError` naming the broken guarantee.
 *
 * Covered: identity binding with indistinguishable `410` failures, detached
 * frozen snapshots, JSON validation, revision locks (`409 STALE_REVISION`),
 * one transaction per entry (`409 COMPONENT_BUSY`, callback never invoked),
 * at-most-once callbacks under a race, invalidation after a failed callback,
 * no resurrection by commits after revoke/delete/expiry, TTL, revocation by
 * binding, child references, per-binding capacity, and replica sharing.
 */
export function liveStoreContract(
  factory: () => LiveStoreContractHarness | Promise<LiveStoreContractHarness>,
): readonly LiveStoreContractCase[] {
  const cases: LiveStoreContractCase[] = [];
  const define = (name: string, body: Body) =>
    cases.push({
      name,
      async run() {
        const harness = await factory();
        const opened: LiveStateStore[] = [];
        const store = async (
          options: {
            readonly ttlMs?: number;
            readonly maxEntries?: number;
          } = {},
        ) => {
          const created = await harness.store({
            ttlMs: options.ttlMs ?? 900_000,
            ...(options.maxEntries === undefined
              ? {}
              : { maxEntries: options.maxEntries }),
          });
          opened.push(created);
          return created;
        };
        try {
          await body(store, harness);
        } finally {
          for (const created of opened.reverse()) await created.close();
          await harness.dispose?.();
        }
      },
    });

  define('implements the structural interface the Live runtime accepts', async (store) => {
    assert.equal(isLiveStateStore(await store()), true, 'isLiveStateStore');
  });

  define('creates detached frozen snapshots readable only with the same binding', async (store) => {
    const live = await store();
    const input = { count: 1, tags: ['a'], nested: { ok: true } };
    const created = await live.create('counter', alice, input);
    input.count = 99;
    assert.equal(created.name, 'counter');
    assert.equal(created.revision, 0);
    assert.deepEqual(
      plain(created.state),
      { count: 1, tags: ['a'], nested: { ok: true } },
      'state is copied at create time',
    );
    assert.match(
      created.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'id is a UUID v4',
    );
    assert.match(created.snapshot, /^[A-Za-z0-9_-]{43}$/, '256-bit token');
    assert.equal(Object.isFrozen(created.state), true, 'frozen state');
    const read = await live.peek(created.snapshot, alice);
    assert.deepEqual(plain(read.state), plain(created.state));
    assert.equal(read.expiresAt, created.expiresAt);
    assert.equal(Object.isFrozen(read.state), true, 'peek is frozen');
    const second = await live.create('counter', alice, {});
    assert.notEqual(second.snapshot, created.snapshot, 'unique tokens');
    assert.notEqual(second.id, created.id, 'unique ids');
    const unknown = randomBytes(32).toString('base64url');
    for (const [label, attempt] of [
      ['foreign binding', () => live.peek(created.snapshot, bob)],
      ['foreign tenant', () => live.peek(created.snapshot, otherTenant)],
      ['unknown token', () => live.peek(unknown, alice)],
      ['malformed token', () => live.peek('not-a-token', alice)],
      ['empty binding', () => live.peek(created.snapshot, '')],
    ] as const)
      assert.equal(await outcome(attempt), 'INVALID_SNAPSHOT:410', label);
  });

  define('rejects invalid component names and non-JSON state', async (store) => {
    const live = await store();
    assert.equal(
      await outcome(() => live.create('Bad Name', alice, {})),
      'INVALID_STATE:400',
    );
    assert.equal(
      await outcome(() => live.create('counter', alice, { value: Number.NaN })),
      'INVALID_REQUEST:400',
    );
    const hostile = JSON.parse('{"__proto__":{"x":1}}') as Record<
      string,
      JsonValue
    >;
    assert.equal(
      await outcome(() => live.create('counter', alice, hostile)),
      'INVALID_REQUEST:400',
    );
  });

  define('commits revision + 1 and rejects stale or replayed revisions before the callback', async (store) => {
    const live = await store();
    const created = await live.create('counter', alice, { count: 0 });
    const result = await live.transaction(
      created.snapshot,
      alice,
      0,
      async (snapshot) => {
        assert.equal(Object.isFrozen(snapshot.state), true, 'frozen input');
        return commit({ count: count(snapshot) + 1 });
      },
    );
    assert.equal(result.revision, 1);
    assert.equal(result.state['count'], 1);
    assert.equal(result.html, '<p>ok</p>');
    assert.equal(result.snapshot, created.snapshot, 'token is stable');
    assert.equal(result.id, created.id);
    assert.equal((await live.peek(created.snapshot, alice)).revision, 1);
    let calls = 0;
    const counted = async (snapshot: StateSnapshot) => {
      calls++;
      return commit(snapshot.state);
    };
    for (const revision of [0, 2, -1, 1.5, Number.MAX_SAFE_INTEGER])
      assert.equal(
        await outcome(() =>
          live.transaction(created.snapshot, alice, revision, counted),
        ),
        'STALE_REVISION:409',
        `revision ${revision}`,
      );
    assert.equal(
      await outcome(() => live.transaction(created.snapshot, bob, 1, counted)),
      'INVALID_SNAPSHOT:410',
      'foreign binding',
    );
    assert.equal(calls, 0, 'callback never invoked for refused requests');
    assert.equal((await live.peek(created.snapshot, alice)).revision, 1);
  });

  define('runs one transaction per entry and refuses a concurrent one with COMPONENT_BUSY', async (store) => {
    const live = await store();
    const created = await live.create('counter', alice, { count: 0 });
    const held = gate();
    const first = live.transaction(created.snapshot, alice, 0, async (s) => {
      await held.wait;
      return commit({ count: count(s) + 1 });
    });
    await pause(30);
    let ran = false;
    assert.equal(
      await outcome(() =>
        live.transaction(created.snapshot, alice, 0, async (s) => {
          ran = true;
          return commit(s.state);
        }),
      ),
      'COMPONENT_BUSY:409',
    );
    held.open();
    assert.equal((await first).revision, 1);
    assert.equal(ran, false, 'the refused callback never ran');
    const next = await live.transaction(created.snapshot, alice, 1, (s) =>
      commit(s.state),
    );
    assert.equal(next.revision, 2, 'the lock is released after commit');
  });

  define('lets exactly one of many racing transactions on a revision run its callback', async (store) => {
    const live = await store();
    const created = await live.create('counter', alice, { count: 0 });
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        outcome(() =>
          live.transaction(created.snapshot, alice, 0, async (s) => {
            calls++;
            await pause(10);
            return commit({ count: count(s) + 1 });
          }),
        ),
      ),
    );
    assert.equal(calls, 1, 'callback ran exactly once');
    assert.equal(results.filter((value) => value === 'ok').length, 1);
    for (const value of results)
      assert.ok(
        ['ok', 'COMPONENT_BUSY:409', 'STALE_REVISION:409'].includes(value),
        `unexpected outcome ${value}`,
      );
    const after = await live.peek(created.snapshot, alice);
    assert.equal(after.revision, 1);
    assert.equal(after.state['count'], 1);
  });

  define('invalidates the entry when the callback fails instead of permitting a retry', async (store) => {
    const live = await store();
    const created = await live.create('counter', alice, { count: 0 });
    await assert.rejects(
      live.transaction(created.snapshot, alice, 0, async () => {
        throw new Error('side effect may have happened');
      }),
      /side effect may have happened/,
      'the callback error propagates unchanged',
    );
    assert.equal(
      await outcome(() => live.peek(created.snapshot, alice)),
      'INVALID_SNAPSHOT:410',
    );
    const big = await live.create('counter', alice, { count: 0 });
    assert.equal(
      await outcome(() =>
        live.transaction(big.snapshot, alice, 0, (s) =>
          commit(s.state, 'x'.repeat(1_048_577)),
        ),
      ),
      'PAYLOAD_TOO_LARGE:413',
    );
    assert.equal(
      await outcome(() => live.peek(big.snapshot, alice)),
      'INVALID_SNAPSHOT:410',
    );
  });

  define('never resurrects state revoked, deleted or expired during a transaction', async (store, harness) => {
    const live = await store({ ttlMs: 60_000 });
    for (const interrupt of ['revoke', 'delete', 'expire'] as const) {
      const created = await live.create('counter', alice, { count: 0 });
      const result = await outcome(() =>
        live.transaction(created.snapshot, alice, 0, async () => {
          if (interrupt === 'revoke') await live.revoke(alice);
          else if (interrupt === 'delete') await live.delete(created.snapshot);
          else harness.advance(60_001);
          return commit({ count: 5 });
        }),
      );
      assert.equal(result, 'INVALID_SNAPSHOT:410', interrupt);
      assert.equal(
        await outcome(() => live.peek(created.snapshot, alice)),
        'INVALID_SNAPSHOT:410',
        `${interrupt}: stays gone`,
      );
    }
  });

  define('expires entries after the TTL', async (store, harness) => {
    const live = await store({ ttlMs: 1000 });
    const created = await live.create('counter', alice, { count: 0 });
    harness.advance(999);
    assert.equal((await live.peek(created.snapshot, alice)).revision, 0);
    harness.advance(1);
    assert.equal(
      await outcome(() => live.peek(created.snapshot, alice)),
      'INVALID_SNAPSHOT:410',
    );
    assert.equal(
      await outcome(() =>
        live.transaction(created.snapshot, alice, 0, (s) => commit(s.state)),
      ),
      'INVALID_SNAPSHOT:410',
    );
  });

  define('revokes every entry of one binding and nothing else; deletes by token', async (store) => {
    const live = await store();
    const a1 = await live.create('counter', alice, { n: 1 });
    const a2 = await live.create('editor', alice, { n: 2 });
    const b1 = await live.create('counter', bob, { n: 3 });
    const t1 = await live.create('counter', otherTenant, { n: 4 });
    await live.revoke(alice);
    for (const token of [a1.snapshot, a2.snapshot])
      assert.equal(
        await outcome(() => live.peek(token, alice)),
        'INVALID_SNAPSHOT:410',
      );
    assert.equal((await live.peek(b1.snapshot, bob)).state['n'], 3);
    assert.equal((await live.peek(t1.snapshot, otherTenant)).state['n'], 4);
    assert.equal(await live.delete(b1.snapshot), true);
    assert.equal(await live.delete(b1.snapshot), false, 'second delete');
    assert.equal(await live.delete('malformed'), false);
    assert.equal(
      await outcome(() => live.peek(b1.snapshot, bob)),
      'INVALID_SNAPSHOT:410',
    );
  });

  define('keeps child references across commits unless the callback replaces them', async (store) => {
    const live = await store();
    const child = await live.create('row', alice, { label: 'a' });
    const parent = await live.create(
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
    assert.equal(parent.children?.['first']?.token, child.snapshot);
    const kept = await live.transaction(parent.snapshot, alice, 0, (s) =>
      commit(s.state),
    );
    assert.equal(kept.children?.['first']?.id, child.id, 'kept');
    const replaced = await live.transaction(
      parent.snapshot,
      alice,
      1,
      async (s) => ({ state: { ...s.state }, html: '', children: {} }),
    );
    assert.deepEqual(plain(replaced.children), {}, 'replaced');
    assert.deepEqual(
      plain((await live.peek(parent.snapshot, alice)).children),
      {},
    );
  });

  define('bounds the entries one binding can hold (STORE_CAPACITY)', async (store, harness) => {
    if (!harness.boundsEntriesPerBinding) return;
    const live = await store({ maxEntries: 2 });
    await live.create('counter', alice, {});
    await live.create('counter', alice, {});
    assert.equal(
      await outcome(() => live.create('counter', alice, {})),
      'STORE_CAPACITY:503',
    );
  });

  define('shares state, locks and revocation between instances only when shared', async (store, harness) => {
    const a = await store();
    const b = await store();
    const created = await a.create('counter', alice, { count: 0 });
    if (!harness.shared) {
      assert.equal(
        await outcome(() => b.peek(created.snapshot, alice)),
        'INVALID_SNAPSHOT:410',
        'process-local instances never share entries',
      );
      return;
    }
    const continued = await b.transaction(created.snapshot, alice, 0, (s) =>
      commit({ count: count(s) + 1 }),
    );
    assert.equal(continued.state['count'], 1);
    assert.equal((await a.peek(created.snapshot, alice)).revision, 1);
    const held = gate();
    const onA = a.transaction(created.snapshot, alice, 1, async (s) => {
      await held.wait;
      return commit(s.state);
    });
    await pause(30);
    assert.equal(
      await outcome(() =>
        b.transaction(created.snapshot, alice, 1, (s) => commit(s.state)),
      ),
      'COMPONENT_BUSY:409',
      'the lock is shared',
    );
    held.open();
    await onA;
    assert.equal(
      await outcome(() =>
        b.transaction(created.snapshot, alice, 1, (s) => commit(s.state)),
      ),
      'STALE_REVISION:409',
      'a replay on the other instance is stale',
    );
    await b.revoke(alice);
    assert.equal(
      await outcome(() => a.peek(created.snapshot, alice)),
      'INVALID_SNAPSHOT:410',
      'revocation is shared',
    );
  });

  return Object.freeze(cases);
}
