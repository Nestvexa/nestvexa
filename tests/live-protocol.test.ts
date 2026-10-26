import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  cloneState,
  isSnapshotToken,
  LIVE_LIMITS,
  LIVE_PROTOCOL,
  LiveProtocolError,
  parseLiveRequest,
  type JsonValue,
} from '../packages/live/src/protocol.js';
import { MemoryLiveStore } from '../packages/live/src/store.js';

const token = Buffer.alloc(32, 7).toString('base64url');
const requestId = 'd85e7c20-72ac-4e71-8baf-210dbe79e912';
function envelope() {
  return {
    protocol: LIVE_PROTOCOL,
    requestId,
    snapshot: token,
    revision: 0,
    updates: { count: 1 },
  };
}
function expectCode(
  operation: () => unknown,
  code: string,
  status?: number,
): void {
  try {
    operation();
    expect.fail('Expected a protocol rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(LiveProtocolError);
    expect(error).toMatchObject({
      code,
      ...(status === undefined ? {} : { status }),
    });
  }
}
function barrier() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release() {
      if (!release) throw new Error('Barrier missing resolver');
      release();
    },
  };
}

describe('Live protocol envelope', () => {
  it('parses the golden envelope and optional nested input without sharing mutable state', () => {
    const request = {
      ...envelope(),
      input: { lines: [{ quantity: 2 }], note: 'مرحبا <script>' },
    };
    const parsed = parseLiveRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.updates)).toBe(true);
    expect(Object.isFrozen(parsed.input)).toBe(true);
    request.updates.count = 99;
    expect(parsed.updates['count']).toBe(1);
  });
  it('omits input when absent and preserves explicit null', () => {
    expect(Object.hasOwn(parseLiveRequest(envelope()), 'input')).toBe(false);
    expect(parseLiveRequest({ ...envelope(), input: null }).input).toBeNull();
  });
  it.each([
    {},
    null,
    [],
    { ...envelope(), extra: true },
    { ...envelope(), requestId: 'not-a-uuid' },
    { ...envelope(), snapshot: 'short' },
    { ...envelope(), revision: -1 },
    { ...envelope(), revision: 0.5 },
    { ...envelope(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope(), updates: [] },
    { ...envelope(), updates: null },
    { ...envelope(), updates: { 'a.b': 1 } },
    { ...envelope(), updates: { 'x/y': 1 } },
    { ...envelope(), input: undefined },
  ])('rejects malformed envelopes %j', (value) =>
    expectCode(() => parseLiveRequest(value), 'INVALID_REQUEST', 400),
  );
  it('rejects unsupported protocol versions with reload status', () =>
    expectCode(
      () => parseLiveRequest({ ...envelope(), protocol: 'nestvexa-live/2' }),
      'UNSUPPORTED_PROTOCOL',
      426,
    ));
  it('rejects noncanonical and wrong-length tokens', () => {
    expect(isSnapshotToken(token)).toBe(true);
    expect(isSnapshotToken(`${token}=`)).toBe(false);
    expect(isSnapshotToken(Buffer.alloc(31).toString('base64url'))).toBe(false);
    expect(isSnapshotToken(`${token.slice(0, -1)}B`)).toBe(false);
  });
});

describe('bounded JSON state', () => {
  it('round trips representative JSON including unicode and repeated shared references', () => {
    const child = {
      label: 'العربية 😀',
      enabled: true,
      missing: null,
      values: [0, -4.2, ''],
    };
    const input = { first: child, second: child };
    const cloned = cloneState(input);
    expect(JSON.stringify(cloned)).toBe(JSON.stringify(input));
    expect(cloned['first']).not.toBe(child);
    expect(cloned['first']).not.toBe(cloned['second']);
    child.label = 'changed';
    expect(JSON.stringify(cloned)).toContain('العربية');
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    new Date(),
    new Map(),
    new Set(),
    () => 1,
    Symbol('unsafe'),
  ])('rejects non-JSON values %s', (value) =>
    expectCode(() => cloneState({ value }), 'INVALID_REQUEST'),
  );
  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects dangerous keys at every nested level: %s',
    (key) => {
      expectCode(
        () => cloneState(JSON.parse(`{"nested":{"${key}":true}}`)),
        'INVALID_REQUEST',
      );
    },
  );
  it('rejects cycles, sparse/augmented arrays, symbols and class instances', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const augmented = [1];
    Object.defineProperty(augmented, 'other', { value: 2 });
    class Model {
      value = 1;
    }
    for (const input of [
      cyclic,
      { list: new Array(3) },
      { list: augmented },
      { [Symbol('secret')]: 1 },
      new Model(),
    ])
      expectCode(() => cloneState(input), 'INVALID_REQUEST');
  });
  it('does not invoke object/array getters or toJSON', () => {
    const getter = vi.fn(() => 1);
    const toJSON = vi.fn(() => ({ okay: true }));
    const object = {};
    Object.defineProperty(object, 'secret', { get: getter, enumerable: true });
    const array = [1];
    Object.defineProperty(array, '0', { get: getter, enumerable: true });
    for (const input of [object, { array }, { toJSON }])
      expectCode(() => cloneState(input), 'INVALID_REQUEST');
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
  it('enforces exact JSON byte boundaries including escaped control characters and Unicode', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ data: '' }));
    expect(
      cloneState({ data: 'a'.repeat(LIVE_LIMITS.maxBytes - overhead) })['data'],
    ).toHaveLength(LIVE_LIMITS.maxBytes - overhead);
    expectCode(
      () =>
        cloneState({ data: 'a'.repeat(LIVE_LIMITS.maxBytes - overhead + 1) }),
      'PAYLOAD_TOO_LARGE',
      413,
    );
    expectCode(
      () => cloneState({ data: '\0'.repeat(12_000) }),
      'PAYLOAD_TOO_LARGE',
      413,
    );
    expectCode(
      () => cloneState({ data: '😀'.repeat(17_000) }),
      'PAYLOAD_TOO_LARGE',
      413,
    );
    expectCode(
      () =>
        parseLiveRequest({
          ...envelope(),
          input: 'a'.repeat(LIVE_LIMITS.maxBytes),
        }),
      'PAYLOAD_TOO_LARGE',
    );
  });
  it('bounds depth and total nodes independently of byte size', () => {
    let nested: JsonValue = null;
    for (let depth = 0; depth < 16; depth++) nested = { child: nested };
    expectCode(() => cloneState({ root: nested }), 'PAYLOAD_TOO_LARGE');
    expectCode(
      () => cloneState({ many: Array.from({ length: 4999 }, () => 0) }),
      'PAYLOAD_TOO_LARGE',
    );
    expect(
      cloneState({ many: Array.from({ length: 4998 }, () => 0) })['many'],
    ).toHaveLength(4998);
  });
});

describe('opaque single-process Live store', () => {
  it('generates unpredictable opaque tokens and detached immutable snapshots', () => {
    const store = new MemoryLiveStore({ now: () => 1000 });
    const input = { count: 0, nested: { label: 'public' } };
    const first = store.create('counter', 'session:user:tenant', input);
    const second = store.create('counter', 'session:user:tenant', input);
    expect(isSnapshotToken(first.snapshot)).toBe(true);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(first.id).not.toBe(second.id);
    expect(first.expiresAt).toBe(901000);
    expect(first).not.toHaveProperty('binding');
    expect(Object.isFrozen(first.state['nested'])).toBe(true);
    input.count = 10;
    input.nested.label = 'changed';
    const peeked = store.peek(first.snapshot, 'session:user:tenant');
    expect(peeked.state).toEqual({ count: 0, nested: { label: 'public' } });
    expect(peeked.state).not.toBe(first.state);
  });
  it('does not reveal whether a token exists when binding or expiry is wrong', () => {
    let now = 0;
    const store = new MemoryLiveStore({ now: () => now, ttlMs: 10 });
    const snapshot = store.create('counter', 'session:A:tenant1', {});
    for (const binding of ['session:B:tenant1', 'session:A:tenant2', ''])
      expectCode(
        () => store.peek(snapshot.snapshot, binding),
        'INVALID_SNAPSHOT',
        410,
      );
    expectCode(
      () =>
        store.peek(randomBytes(32).toString('base64url'), 'session:A:tenant1'),
      'INVALID_SNAPSHOT',
      410,
    );
    now = 10;
    expectCode(
      () => store.peek(snapshot.snapshot, 'session:A:tenant1'),
      'INVALID_SNAPSHOT',
      410,
    );
    expect(store.size).toBe(0);
  });
  it('advances revision only after successful validated rendering and rejects stale replay before effects', async () => {
    const store = new MemoryLiveStore();
    const snapshot = store.create('counter', 'owner', { count: 0 });
    const effect = vi.fn(async () => ({
      state: { count: 1 },
      html: '<output>1</output>',
    }));
    const result = await store.transaction(
      snapshot.snapshot,
      'owner',
      0,
      effect,
    );
    expect(result).toMatchObject({
      revision: 1,
      state: { count: 1 },
      html: '<output>1</output>',
      snapshot: snapshot.snapshot,
    });
    await expect(
      store.transaction(snapshot.snapshot, 'owner', 0, effect),
    ).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409 });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(store.peek(snapshot.snapshot, 'owner').revision).toBe(1);
  });
  it('takes its lock synchronously and rejects overlapping effects, but releases after success', async () => {
    const store = new MemoryLiveStore();
    const snapshot = store.create('counter', 'owner', {});
    const gate = barrier();
    const effect = vi.fn(async () => {
      await gate.promise;
      return { state: { count: 1 }, html: 'one' };
    });
    const first = store.transaction(snapshot.snapshot, 'owner', 0, effect);
    await expect(
      store.transaction(snapshot.snapshot, 'owner', 0, effect),
    ).rejects.toMatchObject({ code: 'COMPONENT_BUSY', status: 409 });
    expect(effect).toHaveBeenCalledTimes(1);
    gate.release();
    await first;
    await expect(
      store.transaction(snapshot.snapshot, 'owner', 1, async () => ({
        state: { count: 2 },
        html: 'two',
      })),
    ).resolves.toMatchObject({ revision: 2 });
  });
  it('invalidates the token after a callback failure without pretending to undo effects', async () => {
    const store = new MemoryLiveStore();
    const snapshot = store.create('counter', 'owner', {});
    let effects = 0;
    const callback = async () => {
      effects++;
      throw new Error('business failure');
    };
    await expect(
      store.transaction(snapshot.snapshot, 'owner', 0, callback),
    ).rejects.toThrow('business failure');
    await expect(
      store.transaction(snapshot.snapshot, 'owner', 0, callback),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    expect(effects).toBe(1);
    expect(store.size).toBe(0);
  });
  it('invalidates state after oversized HTML or invalid callback state', async () => {
    const store = new MemoryLiveStore();
    const first = store.create('counter', 'owner', {});
    await expect(
      store.transaction(first.snapshot, 'owner', 0, async () => ({
        state: { count: NaN },
        html: '',
      })),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const second = store.create('counter', 'owner', {});
    await expect(
      store.transaction(second.snapshot, 'owner', 0, async () => ({
        state: {},
        html: 'a'.repeat(1_048_577),
      })),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(store.size).toBe(0);
  });
  it.each(['revoke', 'delete', 'clear', 'expire'] as const)(
    'does not resurrect an in-flight entry after %s',
    async (operation) => {
      let now = 0;
      const store = new MemoryLiveStore({ now: () => now, ttlMs: 10 });
      const snapshot = store.create('counter', 'owner', {});
      const gate = barrier();
      const pending = store.transaction(
        snapshot.snapshot,
        'owner',
        0,
        async () => {
          await gate.promise;
          return { state: { count: 1 }, html: 'one' };
        },
      );
      if (operation === 'revoke') store.revoke('owner');
      if (operation === 'delete') store.delete(snapshot.snapshot);
      if (operation === 'clear') store.clear();
      if (operation === 'expire') now = 10;
      gate.release();
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
      expect(store.size).toBe(0);
    },
  );
  it('revokes only the authoritative binding and permits independent components concurrently', async () => {
    const store = new MemoryLiveStore();
    const first = store.create('counter', 'tenant-one', {});
    const second = store.create('counter', 'tenant-two', {});
    await Promise.all([
      store.transaction(first.snapshot, 'tenant-one', 0, async () => ({
        state: { count: 1 },
        html: 'one',
      })),
      store.transaction(second.snapshot, 'tenant-two', 0, async () => ({
        state: { count: 2 },
        html: 'two',
      })),
    ]);
    store.revoke('tenant-one');
    expectCode(
      () => store.peek(first.snapshot, 'tenant-one'),
      'INVALID_SNAPSHOT',
    );
    expect(store.peek(second.snapshot, 'tenant-two').state['count']).toBe(2);
  });
  it('does not invoke callbacks for unknown tokens, wrong owners or invalid revisions', async () => {
    const store = new MemoryLiveStore();
    const snapshot = store.create('counter', 'owner', {});
    const effect = vi.fn(async () => ({ state: {}, html: '' }));
    await expect(
      store.transaction(token, 'owner', 0, effect),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      store.transaction(snapshot.snapshot, 'another-owner', 0, effect),
    ).rejects.toMatchObject({ status: 410 });
    for (const revision of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER])
      await expect(
        store.transaction(snapshot.snapshot, 'owner', revision, effect),
      ).rejects.toMatchObject({ status: 409 });
    expect(effect).not.toHaveBeenCalled();
  });
  it('bounds capacity without evicting active users and reclaims expired entries on create', () => {
    let now = 0;
    const store = new MemoryLiveStore({
      maxEntries: 1,
      ttlMs: 5,
      now: () => now,
    });
    const first = store.create('counter', 'owner', {});
    expectCode(
      () => store.create('counter', 'other', {}),
      'STORE_CAPACITY',
      503,
    );
    expect(store.peek(first.snapshot, 'owner').revision).toBe(0);
    now = 5;
    expect(store.create('counter', 'other', {}).revision).toBe(0);
    expect(store.size).toBe(1);
    expect(store.delete(first.snapshot)).toBe(false);
  });
  it.each(['expire', 'revoke', 'delete', 'clear'] as const)(
    'retains a bounded execution slot after %s until the old callback settles',
    async (operation) => {
      let now = 0;
      const store = new MemoryLiveStore({
        maxEntries: 1,
        ttlMs: 10,
        now: () => now,
      });
      const first = store.create('counter', 'owner', {});
      const gate = barrier();
      const pending = store.transaction(
        first.snapshot,
        'owner',
        0,
        async () => {
          await gate.promise;
          return { state: {}, html: 'old' };
        },
      );
      if (operation === 'expire') now = 10;
      if (operation === 'revoke') store.revoke('owner');
      if (operation === 'delete') store.delete(first.snapshot);
      if (operation === 'clear') store.clear();
      const second = store.create('counter', 'owner', {});
      const effect = vi.fn(async () => ({ state: {}, html: 'new' }));
      await expect(
        store.transaction(second.snapshot, 'owner', 0, effect),
      ).rejects.toMatchObject({ code: 'STORE_CAPACITY', status: 503 });
      expect(effect).not.toHaveBeenCalled();
      expect(store.peek(second.snapshot, 'owner').revision).toBe(0);
      gate.release();
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
      await expect(
        store.transaction(second.snapshot, 'owner', 0, effect),
      ).resolves.toMatchObject({ revision: 1 });
      expect(effect).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects tampered canonical tokens before invoking effects', async () => {
    const store = new MemoryLiveStore();
    const initial = store.create('counter', 'owner', {});
    const bytes = Buffer.from(initial.snapshot, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const effect = vi.fn(async () => ({ state: {}, html: '' }));
    await expect(
      store.transaction(bytes.toString('base64url'), 'owner', 0, effect),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT', status: 410 });
    expect(effect).not.toHaveBeenCalled();
    expect(store.peek(initial.snapshot, 'owner').revision).toBe(0);
  });
  it('rejects invalid store options and injected generators', () => {
    for (const options of [
      { ttlMs: 0 },
      { ttlMs: Infinity },
      { maxEntries: 0 },
      { maxEntries: 1.2 },
      { ttlMs: 86_400_001 },
    ])
      expectCode(() => new MemoryLiveStore(options), 'INVALID_STORE_OPTIONS');
    expectCode(
      () =>
        new MemoryLiveStore({ now: () => NaN }).create('counter', 'owner', {}),
      'INVALID_STORE_OPTIONS',
    );
    expectCode(
      () =>
        new MemoryLiveStore({ randomToken: () => 'bad' }).create(
          'counter',
          'owner',
          {},
        ),
      'INVALID_STORE_OPTIONS',
    );
    expectCode(
      () =>
        new MemoryLiveStore({ randomId: () => 'bad' }).create(
          'counter',
          'owner',
          {},
        ),
      'INVALID_STORE_OPTIONS',
    );
    const store = new MemoryLiveStore({ randomToken: () => token });
    store.create('counter', 'owner', {});
    expectCode(
      () => store.create('counter', 'owner', {}),
      'INVALID_STORE_OPTIONS',
    );
    expectCode(() => store.create('../counter', 'owner', {}), 'INVALID_STATE');
  });
});
