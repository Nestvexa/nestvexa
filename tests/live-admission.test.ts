/**
 * Live action admission (`LiveRuntime.admit`, the class guard that runs before
 * application guards): origin, content type, identity bounds, CSRF, rate limit,
 * snapshot ownership, action allowlist, authorization and shutdown. The suite
 * imports the TypeScript source so mutation testing (`pnpm test:mutation`)
 * measures exactly these checks; each boundary has an accepted and a rejected
 * neighbour.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  State,
  definition,
} from '../packages/live/src/metadata.js';
import { LIVE_PROTOCOL } from '../packages/live/src/protocol.js';
import { LiveApplicationRegistry } from '../packages/live/src/registration.js';
import { LIVE_OPTIONS, LiveRuntime } from '../packages/live/src/runtime.js';
import type {
  LiveIdentity,
  RuntimeOptions,
} from '../packages/live/src/runtime.js';
import { MemoryLiveStore } from '../packages/live/src/store.js';

@LiveComponent({ name: 'admission-counter', view: 'unused' })
class Counter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}
@LiveComponent({ name: 'admission-other', view: 'unused' })
class Other {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}

const origin = 'https://app.example.test';
const csrf = 'c'.repeat(32);
const binding = 'session:user-1:tenant-1';

interface Harness {
  readonly runtime: LiveRuntime;
  readonly store: MemoryLiveStore;
  readonly resolveIdentity: ReturnType<typeof vi.fn>;
  readonly authorize: ReturnType<typeof vi.fn>;
  readonly snapshot: string;
}
async function harness(
  overrides: Partial<Pick<RuntimeOptions, 'maxRequestsPerMinute'>> & {
    identity?: unknown;
    allow?: boolean;
  } = {},
): Promise<Harness> {
  const store = new MemoryLiveStore({ maxEntries: 5000 });
  // A hostile or buggy host resolver: the runtime must validate its result.
  const resolved: unknown =
    'identity' in overrides ? overrides.identity : { binding, csrfToken: csrf };
  const resolveIdentity = vi.fn(
    async (): Promise<LiveIdentity> => resolved as LiveIdentity,
  );
  const authorize = vi.fn(async () => overrides.allow ?? true);
  const options: RuntimeOptions = {
    origin,
    resolveIdentity,
    authorize,
    renderer: new HbsEngine({ root: process.cwd() }),
    store,
    definitions: [definition(Counter), definition(Other)],
    ...(overrides.maxRequestsPerMinute === undefined
      ? {}
      : { maxRequestsPerMinute: overrides.maxRequestsPerMinute }),
  };
  const module = await Test.createTestingModule({
    providers: [
      LiveApplicationRegistry,
      { provide: LIVE_OPTIONS, useValue: options },
      LiveRuntime,
    ],
  }).compile();
  const runtime = module.get(LiveRuntime);
  const snapshot = store.create('admission-counter', binding, {
    count: 0,
  }).snapshot;
  return { runtime, store, resolveIdentity, authorize, snapshot };
}
function request(
  snapshot: string,
  headers: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): object {
  return {
    headers: {
      origin,
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf,
      ...headers,
    },
    body: {
      protocol: LIVE_PROTOCOL,
      requestId: 'd85e7c20-72ac-4e71-8baf-210dbe79e912',
      snapshot,
      revision: 0,
      updates: {},
      ...body,
    },
  };
}
async function rejection(
  promise: Promise<unknown>,
): Promise<{ status: number; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse();
    return {
      status: error.getStatus(),
      code:
        typeof response === 'object' && response !== null
          ? Reflect.get(response, 'code')
          : response,
    };
  }
  throw new Error('Expected the admission to be rejected');
}
const counter = definition(Counter);

// Warm Nest DI and the renderer once so the first case is not timed on a cold start.
beforeAll(async () => {
  await harness();
}, 120_000);
afterEach(() => {
  vi.useRealTimers();
});

describe('Live admission: origin and content type', () => {
  it('admits an exact same-origin JSON request', async () => {
    const { runtime, snapshot, authorize } = await harness();
    await expect(
      runtime.admit(request(snapshot), counter, 'increment'),
    ).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(
      { binding, csrfToken: csrf },
      'admission-counter',
      'increment',
    );
  });

  it.each([
    undefined,
    '',
    'https://evil.example.test',
    'https://app.example.test/',
    'HTTPS://APP.EXAMPLE.TEST',
    'http://app.example.test',
    'null',
    ['https://app.example.test'],
  ])('rejects origin %j before resolving the identity', async (value) => {
    const { runtime, snapshot, resolveIdentity } = await harness();
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, { origin: value }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 403, code: 'ORIGIN_REJECTED' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['no headers object', {}],
    ['null headers', { headers: null }],
    ['string headers', { headers: 'origin: https://app.example.test' }],
  ])('rejects a request with %s as ORIGIN_REJECTED', async (_label, shape) => {
    const { runtime, snapshot, resolveIdentity } = await harness();
    const body = Reflect.get(request(snapshot), 'body');
    expect(
      await rejection(runtime.admit({ ...shape, body }, counter, 'increment')),
    ).toEqual({ status: 403, code: 'ORIGIN_REJECTED' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it.each([
    'application/json',
    'application/json;charset=utf-8',
    'application/json ; charset=utf-8',
    'APPLICATION/JSON; Charset=UTF-8',
  ])('accepts content type %j', async (value) => {
    const { runtime, snapshot } = await harness();
    await expect(
      runtime.admit(
        request(snapshot, { 'content-type': value }),
        counter,
        'increment',
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    undefined,
    '',
    'text/plain',
    'application/jsonx',
    'xapplication/json',
    'application/json; charset=latin1',
    'application/json; charset=utf-8; boundary=x',
    'multipart/form-data',
    'application/x-www-form-urlencoded',
    // Only string header values count; a repeated header is never coerced.
    ['application/json'],
  ])('rejects content type %j with 415', async (value) => {
    const { runtime, snapshot, resolveIdentity } = await harness();
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, { 'content-type': value }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 415, code: 'CONTENT_TYPE' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});

describe('Live admission: identity bounds and CSRF', () => {
  it.each([
    ['binding of 16 characters', 'b'.repeat(16), csrf],
    ['binding of 1024 characters', 'b'.repeat(1024), csrf],
    ['token of 256 characters', binding, 't'.repeat(256)],
  ])('accepts a %s', async (_label, identityBinding, token) => {
    const { runtime, store } = await harness({
      identity: { binding: identityBinding, csrfToken: token },
    });
    const snapshot = store.create('admission-counter', identityBinding, {
      count: 0,
    }).snapshot;
    await expect(
      runtime.admit(
        request(snapshot, { 'x-nestvexa-csrf': token }),
        counter,
        'increment',
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['no identity', null],
    ['binding of 15 characters', { binding: 'b'.repeat(15), csrfToken: csrf }],
    [
      'binding of 1025 characters',
      { binding: 'b'.repeat(1025), csrfToken: csrf },
    ],
    ['token of 31 characters', { binding, csrfToken: 't'.repeat(31) }],
    ['token of 257 characters', { binding, csrfToken: 't'.repeat(257) }],
    ['a non-string binding', { binding: ['b'.repeat(16)], csrfToken: csrf }],
    ['a non-string token', { binding, csrfToken: 1 }],
  ])('rejects %s with 401', async (_label, identity) => {
    const { runtime, snapshot, authorize } = await harness({ identity });
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 401, code: 'IDENTITY_REQUIRED' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a same-length wrong token', 'd'.repeat(32)],
    ['a prefix of the token', 'c'.repeat(31)],
    ['a longer token', 'c'.repeat(33)],
    ['an array header', [csrf]],
  ])('rejects %s as CSRF_REJECTED', async (_label, value) => {
    const { runtime, snapshot, authorize } = await harness();
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, { 'x-nestvexa-csrf': value }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 403, code: 'CSRF_REJECTED' });
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('Live admission: rate limit', () => {
  it('admits exactly maxRequestsPerMinute requests per identity and window', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const { runtime, snapshot } = await harness({ maxRequestsPerMinute: 3 });
    for (let index = 0; index < 3; index++)
      await runtime.admit(request(snapshot), counter, 'increment');
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 429, code: 'RATE_LIMIT' });
    // Still inside the 60-second window.
    vi.setSystemTime(1_000_000 + 59_999);
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 429, code: 'RATE_LIMIT' });
    // The window resets exactly at 60 seconds.
    vi.setSystemTime(1_000_000 + 60_000);
    await expect(
      runtime.admit(request(snapshot), counter, 'increment'),
    ).resolves.toBeUndefined();
  });

  it('defaults to 60 requests per minute', async () => {
    vi.useFakeTimers({ now: 5_000_000, toFake: ['Date'] });
    const { runtime, snapshot } = await harness();
    for (let index = 0; index < 60; index++)
      await runtime.admit(request(snapshot), counter, 'increment');
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 429, code: 'RATE_LIMIT' });
  });

  it('bounds tracked identities at 1000 per window', async () => {
    vi.useFakeTimers({ now: 9_000_000, toFake: ['Date'] });
    let current = 0;
    const { runtime, store, resolveIdentity } = await harness();
    resolveIdentity.mockImplementation(async () => ({
      binding: `session:${String(current).padStart(16, '0')}`,
      csrfToken: csrf,
    }));
    const admit = async (index: number): Promise<void> => {
      current = index;
      const owner = `session:${String(index).padStart(16, '0')}`;
      const snapshot = store.create('admission-counter', owner, {
        count: 0,
      }).snapshot;
      await runtime.admit(request(snapshot), counter, 'increment');
    };
    for (let index = 0; index < 1000; index++) await admit(index);
    expect(await rejection(admit(1000))).toEqual({
      status: 429,
      code: 'RATE_LIMIT',
    });
    // A known identity still has its own bucket.
    await expect(admit(1)).resolves.toBeUndefined();
    vi.setSystemTime(9_000_000 + 60_000);
    await expect(admit(1001)).resolves.toBeUndefined();
  });
});

describe('Live admission: payload, snapshot, action and authorization', () => {
  it('maps protocol errors in the body and capability header', async () => {
    const { runtime, snapshot } = await harness();
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, {}, { protocol: 'nestvexa-live/2' }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 426, code: 'UNSUPPORTED_PROTOCOL' });
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, {}, { revision: -1 }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    expect(
      await rejection(
        runtime.admit(
          request(snapshot, { 'x-nestvexa-capabilities': 'renderless v1' }),
          counter,
          'increment',
        ),
      ),
    ).toEqual({ status: 400, code: 'INVALID_CAPABILITIES' });
    await expect(
      runtime.admit(
        request(snapshot, { 'x-nestvexa-capabilities': 'renderless-v1' }),
        counter,
        'increment',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a snapshot of another component or another identity', async () => {
    const { runtime, store } = await harness();
    const other = store.create('admission-other', binding, {
      count: 0,
    }).snapshot;
    expect(
      await rejection(runtime.admit(request(other), counter, 'increment')),
    ).toEqual({ status: 403, code: 'COMPONENT_MISMATCH' });
    const foreign = store.create('admission-counter', 'session:someone-else', {
      count: 0,
    }).snapshot;
    expect(
      await rejection(runtime.admit(request(foreign), counter, 'increment')),
    ).toEqual({ status: 410, code: 'INVALID_SNAPSHOT' });
  });

  it('allows only declared actions and the internal sync action', async () => {
    const { runtime, snapshot, authorize } = await harness();
    for (const action of ['decrement', 'constructor', '__proto__', 'count'])
      expect(
        await rejection(runtime.admit(request(snapshot), counter, action)),
      ).toEqual({ status: 404, code: 'UNKNOWN_ACTION' });
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      runtime.admit(request(snapshot), counter, '$sync'),
    ).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(
      { binding, csrfToken: csrf },
      'admission-counter',
      '$sync',
    );
  });

  it('rejects when the host authorization returns false', async () => {
    const { runtime, snapshot } = await harness({ allow: false });
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 403, code: 'ACTION_FORBIDDEN' });
  });

  it('rejects every admission after application shutdown', async () => {
    const { runtime, snapshot, resolveIdentity } = await harness();
    await runtime.onApplicationShutdown();
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 503, code: 'LIVE_SHUTDOWN' });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects when shutdown starts while the host authorizes the action', async () => {
    const { runtime, snapshot, authorize } = await harness();
    authorize.mockImplementation(async () => {
      await runtime.onApplicationShutdown();
      return true;
    });
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 503, code: 'LIVE_SHUTDOWN' });
  });

  it('rejects when shutdown starts while the identity is being resolved', async () => {
    const { runtime, snapshot, resolveIdentity } = await harness();
    resolveIdentity.mockImplementation(async () => {
      await runtime.onApplicationShutdown();
      return { binding, csrfToken: csrf };
    });
    expect(
      await rejection(runtime.admit(request(snapshot), counter, 'increment')),
    ).toEqual({ status: 503, code: 'LIVE_SHUTDOWN' });
  });
});
