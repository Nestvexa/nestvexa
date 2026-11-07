import { describe, expect, it } from 'vitest';
import {
  MemoryOfflineReplayStore,
  createOfflineReplayGuard,
  draftScope,
  offlineActionAllowlist,
  offlineServerAction,
} from '../packages/offline/dist/server/index.js';
import type {
  OfflineReplayOutcome,
  OfflineReplayRequest,
} from '../packages/offline/dist/server/index.js';

const secret = 'offline-test-secret-0123456789abcdefghij';
const alice = draftScope(secret, 'user:alice');
const bob = draftScope(secret, 'user:bob');
const allowlist = offlineActionAllowlist([
  { id: 'notes.save', path: '/notes', idempotent: true, label: 'Save note' },
  {
    id: 'profile.update',
    path: '/profile',
    method: 'PATCH',
    encoding: 'action',
    idempotent: true,
  },
]);
const key = 'request-0123456789abcdef';

function call(
  overrides: Partial<OfflineReplayRequest> & {
    readonly headers?: OfflineReplayRequest['headers'];
  } = {},
): OfflineReplayRequest {
  return {
    method: 'POST',
    path: '/notes',
    scope: alice,
    body: { title: 'Groceries' },
    headers: { 'idempotency-key': key, 'x-nestvexa-offline-scope': alice },
    ...overrides,
  };
}
function counter() {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    execute: (): OfflineReplayOutcome<{ id: number }> => ({
      status: 201,
      body: { id: ++runs },
    }),
  };
}

describe('offlineActionAllowlist', () => {
  it('freezes validated definitions and renders an escaped meta element', () => {
    expect(allowlist.actions).toEqual([
      {
        id: 'notes.save',
        path: '/notes',
        method: 'POST',
        encoding: 'form',
        label: 'Save note',
        idempotent: true,
      },
      {
        id: 'profile.update',
        path: '/profile',
        method: 'PATCH',
        encoding: 'action',
        idempotent: true,
      },
    ]);
    expect(Object.isFrozen(allowlist.actions)).toBe(true);
    expect(Object.isFrozen(allowlist.actions[0])).toBe(true);
    expect(allowlist.get('notes.save')?.path).toBe('/notes');
    expect(allowlist.match('post', '/notes')?.id).toBe('notes.save');
    expect(allowlist.match('POST', '/profile')).toBeUndefined();
    expect(JSON.parse(allowlist.metaContent)).toEqual({
      v: 1,
      actions: allowlist.actions,
    });
    const tag = offlineActionAllowlist([
      {
        id: 'notes.save',
        path: '/notes',
        idempotent: true,
        label: '"><script>alert(1)</script>',
      },
    ]).metaTag();
    expect(tag).toMatch(/^<meta name="nv-offline-actions" content="[^"<>]*">$/);
    expect(tag).not.toContain('<script');
  });

  it('refuses non-idempotent, delete, payment and malformed definitions', () => {
    const invalid: readonly unknown[] = [
      { id: 'notes.save', path: '/notes' },
      { id: 'notes.save', path: '/notes', idempotent: 'yes' },
      { id: 'notes.save', path: '/notes', idempotent: false },
      {
        id: 'notes.drop',
        path: '/notes/1',
        method: 'DELETE',
        idempotent: true,
      },
      { id: 'notes.read', path: '/notes', method: 'GET', idempotent: true },
      { id: 'cart.checkout', path: '/cart', idempotent: true },
      { id: 'orders.save', path: '/orders/pay', idempotent: true },
      { id: 'notes.erase', path: '/notes', idempotent: true },
      { id: 'billing.save', path: '/billing/makePayment', idempotent: true },
      { id: 'Bad Id', path: '/notes', idempotent: true },
      { id: 'notes.save', path: '//evil.example/notes', idempotent: true },
      { id: 'notes.save', path: 'https://evil.example/', idempotent: true },
      { id: 'notes.save', path: '/notes?x=1', idempotent: true },
      { id: 'notes.save', path: '/notes', idempotent: true, encoding: 'xml' },
      { id: 'notes.save', path: '/notes', idempotent: true, extra: 1 },
      { id: 'notes.save', path: '/notes', idempotent: true, label: '' },
    ];
    for (const definition of invalid)
      expect(() => offlineActionAllowlist([definition] as never)).toThrow(
        TypeError,
      );
    const accessor = {
      id: 'notes.save',
      path: '/notes',
      get idempotent(): true {
        return true;
      },
    };
    expect(() => offlineActionAllowlist([accessor])).toThrow(/data property/);
    expect(() =>
      offlineActionAllowlist([
        { id: 'notes.save', path: '/a', idempotent: true },
        { id: 'notes.save', path: '/b', idempotent: true },
      ]),
    ).toThrow(/Duplicate offline action id/);
    expect(() =>
      offlineActionAllowlist([
        { id: 'notes.a', path: '/a', idempotent: true },
        { id: 'notes.b', path: '/a', idempotent: true },
      ]),
    ).toThrow(/Duplicate offline action route/);
  });

  it('bridges only idempotent @nestvexa/actions descriptors', () => {
    expect(
      offlineServerAction(
        { group: 'notes', action: 'save', version: null, idempotent: true },
        { label: 'Save note' },
      ),
    ).toEqual({
      id: 'notes.save',
      path: '/_nestvexa/actions/notes/save',
      method: 'POST',
      encoding: 'action',
      label: 'Save note',
      idempotent: true,
    });
    expect(
      offlineServerAction(
        { group: 'notes', action: 'save', version: 2, idempotent: true },
        { prefix: '/api/_nestvexa/actions' },
      ).path,
    ).toBe('/api/_nestvexa/actions/notes/save/v2');
    expect(() =>
      offlineServerAction({
        group: 'notes',
        action: 'save',
        version: null,
        idempotent: false,
      }),
    ).toThrow(/not idempotent/);
  });
});

describe('createOfflineReplayGuard', () => {
  it('executes a replayed request ID at most once and returns the stored outcome', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    const handler = counter();
    const first = await guard.run(call(), handler.execute);
    expect(first).toEqual({
      status: 201,
      body: { id: 1 },
      headers: {},
      outcome: 'executed',
    });
    const replayed = await guard.run(call(), handler.execute);
    expect(replayed).toEqual({
      status: 201,
      body: { id: 1 },
      headers: { 'x-nestvexa-offline-replayed': '1' },
      outcome: 'replayed',
    });
    // Header names are matched case-insensitively; array values use the first.
    const again = await guard.run(
      call({
        headers: {
          'Idempotency-Key': [key],
          'X-Nestvexa-Offline-Scope': alice,
        },
      }),
      handler.execute,
    );
    expect(again.outcome).toBe('replayed');
    expect(handler.runs).toBe(1);
    const other = await guard.run(
      call({
        headers: {
          'idempotency-key': 'request-other-0123456789',
          'x-nestvexa-offline-scope': alice,
        },
      }),
      handler.execute,
    );
    expect(other.outcome).toBe('executed');
    expect(handler.runs).toBe(2);
  });

  it('serializes concurrent duplicates: the second is in progress, never executed', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    let release: () => void = () => undefined;
    let runs = 0;
    const slow = guard.run(call(), async () => {
      runs++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: 'ok' };
    });
    await Promise.resolve();
    const duplicate = await guard.run(call(), () => {
      runs++;
      return { status: 200, body: 'duplicate' };
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: { code: 'OFFLINE_IN_PROGRESS' } });
    release();
    expect((await slow).outcome).toBe('executed');
    expect(runs).toBe(1);
  });

  it('refuses a request ID reused with a different body', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    const handler = counter();
    await guard.run(call(), handler.execute);
    const reused = await guard.run(
      call({ body: { title: 'Something else' } }),
      handler.execute,
    );
    expect(reused).toMatchObject({
      status: 422,
      outcome: 'rejected',
      body: { error: { code: 'OFFLINE_KEY_REUSED' } },
    });
    // Key order does not change the fingerprint.
    const reordered = await guard.run(
      call({ body: { title: 'Groceries' } }),
      handler.execute,
    );
    expect(reordered.outcome).toBe('replayed');
    expect(handler.runs).toBe(1);
  });

  it('refuses a non-allowlisted route carrying the offline replay header', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    const handler = counter();
    for (const request of [
      call({ path: '/orders' }),
      call({ method: 'DELETE' }),
      call({ path: '/notes/' }),
    ]) {
      expect(guard.check(request)).toMatchObject({
        status: 403,
        code: 'OFFLINE_NOT_ALLOWED',
      });
      expect(await guard.run(request, handler.execute)).toMatchObject({
        status: 403,
        outcome: 'rejected',
      });
    }
    expect(handler.runs).toBe(0);
    // Idempotency-Key alone may belong to another protocol: not ours to refuse.
    const foreign = call({
      path: '/orders',
      headers: { 'idempotency-key': key },
    });
    expect(guard.check(foreign)).toBeNull();
    expect((await guard.run(foreign, handler.execute)).outcome).toBe(
      'passthrough',
    );
  });

  it('refuses another identity replaying a queued scope and binds keys per identity', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    const handler = counter();
    await guard.run(call(), handler.execute);
    const stolen = await guard.run(call({ scope: bob }), handler.execute);
    expect(stolen).toMatchObject({
      status: 403,
      body: { error: { code: 'OFFLINE_SCOPE_MISMATCH' } },
    });
    // Bob's own entry with the same request ID is a different key: it neither
    // replays Alice's stored result nor collides with it.
    const own = await guard.run(
      call({
        scope: bob,
        headers: { 'idempotency-key': key, 'x-nestvexa-offline-scope': bob },
      }),
      handler.execute,
    );
    expect(own).toMatchObject({ outcome: 'executed', body: { id: 2 } });
    expect(() => guard.check(call({ scope: 'short' }))).toThrow(/draftScope/);
  });

  it('validates the request ID and passes plain submissions through', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    const handler = counter();
    expect(
      guard.check(call({ headers: { 'x-nestvexa-offline-scope': alice } })),
    ).toMatchObject({ status: 400, code: 'OFFLINE_KEY_REQUIRED' });
    for (const bad of ['short', 'x'.repeat(129), 'has space 0123456789'])
      expect(
        guard.check(
          call({
            headers: {
              'idempotency-key': bad,
              'x-nestvexa-offline-scope': alice,
            },
          }),
        ),
      ).toMatchObject({ status: 400, code: 'OFFLINE_KEY_INVALID' });
    const plain = await guard.run(call({ headers: {} }), handler.execute);
    expect(plain.outcome).toBe('passthrough');
    const plainAgain = await guard.run(call({ headers: {} }), handler.execute);
    expect(plainAgain.outcome).toBe('passthrough');
    expect(handler.runs).toBe(2);
  });

  it('releases the request ID after a failure or throw so a retry executes', async () => {
    const guard = createOfflineReplayGuard({ allowlist });
    let runs = 0;
    const failing = await guard.run(call(), () => {
      runs++;
      return { status: 503, body: 'unavailable' };
    });
    expect(failing.outcome).toBe('executed');
    await expect(
      guard.run(call(), () => {
        runs++;
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');
    const succeeded = await guard.run(call(), () => {
      runs++;
      return { status: 200, body: 'saved' };
    });
    expect(succeeded.outcome).toBe('executed');
    expect(
      (await guard.run(call(), () => ({ status: 200, body: 'x' }))).body,
    ).toBe('saved');
    expect(runs).toBe(3);
  });

  it('expires request IDs after the TTL and bounds the memory store', async () => {
    let clock = 1_000_000;
    const store = new MemoryOfflineReplayStore({
      maxEntries: 2,
      now: () => clock,
    });
    const guard = createOfflineReplayGuard({ allowlist, store, ttlMs: 60_000 });
    const handler = counter();
    await guard.run(call(), handler.execute);
    clock += 59_999;
    expect((await guard.run(call(), handler.execute)).outcome).toBe('replayed');
    clock += 2;
    expect((await guard.run(call(), handler.execute)).outcome).toBe('executed');
    expect(handler.runs).toBe(2);
    expect(store.size).toBe(1);
    const releases: (() => void)[] = [];
    const pending = (id: string) =>
      guard.run(
        call({
          headers: {
            'idempotency-key': id,
            'x-nestvexa-offline-scope': alice,
          },
        }),
        () =>
          new Promise<OfflineReplayOutcome<string>>((resolve) => {
            releases.push(() => resolve({ status: 200, body: id }));
          }),
      );
    const one = pending('request-pending-000000001');
    await Promise.resolve();
    // The completed entry is evicted to make room; in-progress work is not.
    const two = pending('request-pending-000000002');
    await Promise.resolve();
    const full = await guard.run(
      call({
        headers: {
          'idempotency-key': 'request-pending-000000003',
          'x-nestvexa-offline-scope': alice,
        },
      }),
      handler.execute,
    );
    expect(full).toMatchObject({
      status: 503,
      body: { error: { code: 'OFFLINE_CAPACITY' } },
    });
    for (const release of releases) release();
    expect((await one).outcome).toBe('executed');
    expect((await two).outcome).toBe('executed');
    expect(store.size).toBe(2);
  });

  it('hands shared stores hashed keys only, never the raw request ID or scope', async () => {
    const seen: string[] = [];
    const inner = new MemoryOfflineReplayStore();
    const guard = createOfflineReplayGuard({
      allowlist,
      store: {
        begin(storeKey, fingerprint, ttlMs) {
          seen.push(storeKey, fingerprint);
          return inner.begin(storeKey, fingerprint, ttlMs);
        },
        complete: (storeKey, outcome) => inner.complete(storeKey, outcome),
        abandon: (storeKey) => inner.abandon(storeKey),
      },
    });
    await guard.run(call(), counter().execute);
    expect(seen).toHaveLength(2);
    for (const value of seen) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value).not.toContain(key);
      expect(value).not.toContain(alice);
    }
  });

  it('validates guard options', () => {
    expect(() => createOfflineReplayGuard({ allowlist, ttlMs: 999 })).toThrow(
      /ttlMs/,
    );
    expect(() =>
      createOfflineReplayGuard({ allowlist, ttlMs: 8 * 24 * 3_600_000 }),
    ).toThrow(/ttlMs/);
    expect(() => new MemoryOfflineReplayStore({ maxEntries: 0 })).toThrow(
      /maxEntries/,
    );
  });
});
