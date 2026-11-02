import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActionError,
  ActionResult,
  KeyedMutex,
  MemoryIdempotencyStore,
  codeForStatus,
  createFixedWindowRateLimit,
  inspectJsonInput,
  isSafeRedirect,
  redirectTo,
  runSchema,
  toJsonSafe,
  withNotifications,
} from '../packages/actions/dist/index.js';
import type { ActionRateLimitContext } from '../packages/actions/dist/index.js';

const limits = { maxDepth: 8, maxNodes: 100 };

describe('request JSON inspection', () => {
  it('accepts plain JSON within bounds', () => {
    expect(
      inspectJsonInput({ input: { a: [1, 'x', null, true] } }, limits),
    ).toEqual({ ok: true });
    expect(inspectJsonInput(Object.create(null) as object, limits)).toEqual({
      ok: true,
    });
  });

  it.each([
    [JSON.parse('{"__proto__":{"admin":true}}') as unknown, 'FORBIDDEN_KEY'],
    [{ a: { constructor: { prototype: {} } } }, 'FORBIDDEN_KEY'],
    [{ prototype: 1 }, 'FORBIDDEN_KEY'],
    [{ a: Number.NaN }, 'NOT_JSON'],
    [{ a: () => 1 }, 'NOT_JSON'],
    [{ a: new Date() }, 'NOT_JSON'],
    [{ a: new Map() }, 'NOT_JSON'],
    [{ [Symbol('s')]: 1 }, 'NOT_JSON'],
    [
      Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }),
      'NOT_JSON',
    ],
    [[[[[[[[[[1]]]]]]]]], 'DEPTH'],
    [Array.from({ length: 200 }, () => 1), 'NODES'],
  ])('rejects %# with %s', (value, problem) => {
    expect(inspectJsonInput(value, limits)).toEqual({ ok: false, problem });
  });

  it('handles adversarial depth without recursion', () => {
    let deep: unknown = 0;
    for (let index = 0; index < 200_000; index++) deep = [deep];
    expect(
      inspectJsonInput(deep, { maxDepth: 32, maxNodes: 1_000_000 }),
    ).toEqual({
      ok: false,
      problem: 'DEPTH',
    });
  });
});

describe('JSON-safe output', () => {
  const bounds = { maxDepth: 64, maxNodes: 10_000 };
  it('copies plain data, applies toJSON and omits undefined properties', () => {
    const source = {
      a: 1,
      b: undefined,
      c: [new Date(0)],
      d: { toJSON: () => 'custom' },
    };
    const result = toJsonSafe(source, bounds);
    expect(result).toEqual({
      ok: true,
      value: { a: 1, c: ['1970-01-01T00:00:00.000Z'], d: 'custom' },
    });
    expect(toJsonSafe(undefined, bounds)).toEqual({ ok: true, value: null });
    const shared = { x: 1 };
    expect(toJsonSafe({ left: shared, right: shared }, bounds).ok).toBe(true);
  });

  it.each([
    [() => 1, '$', 'function value'],
    [{ a: Symbol('s') }, '$.a', 'symbol value'],
    [{ a: 1n }, '$.a', 'bigint value'],
    [{ a: Infinity }, '$.a', 'non-finite number'],
    [[undefined], '$[0]', 'undefined array item'],
    [{ a: new Map() }, '$.a', 'class instance without toJSON()'],
    [
      { 'b c': new (class Entity {})() },
      '$["b c"]',
      'class instance without toJSON()',
    ],
    [{ list: [1, new Set()] }, '$.list[1]', 'class instance without toJSON()'],
    [{ a: new Error('secret') }, '$.a', 'class instance without toJSON()'],
  ])('rejects %# at %s', (value, path, problem) => {
    expect(toJsonSafe(value, bounds)).toEqual({ ok: false, path, problem });
  });

  it('rejects cycles, including through toJSON', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(toJsonSafe(cycle, bounds)).toMatchObject({
      ok: false,
      problem: 'circular reference',
    });
    const selfSerializing: { toJSON(): unknown } = {
      toJSON: () => ({ again: selfSerializing }),
    };
    expect(toJsonSafe(selfSerializing, bounds)).toMatchObject({ ok: false });
    let deep: unknown = 1;
    for (let index = 0; index < 70; index++) deep = { deep };
    expect(toJsonSafe(deep, bounds)).toMatchObject({
      ok: false,
      problem: 'nesting too deep',
    });
  });
});

describe('idempotency store', () => {
  it('starts, detects in-progress/mismatch, replays and expires', () => {
    let now = 1000;
    const store = new MemoryIdempotencyStore({ now: () => now });
    expect(store.begin('k', 'f1', 100)).toEqual({ status: 'started' });
    expect(store.begin('k', 'f1', 100)).toEqual({ status: 'in-progress' });
    expect(store.begin('k', 'f2', 100)).toEqual({ status: 'mismatch' });
    store.complete('k', { data: { ok: 1 } });
    expect(store.begin('k', 'f1', 100)).toEqual({
      status: 'replay',
      outcome: { data: { ok: 1 } },
    });
    now += 100;
    expect(store.begin('k', 'f1', 100)).toEqual({ status: 'started' });
    store.abandon('k');
    expect(store.size).toBe(0);
  });

  it('evicts completed entries first and never evicts in-progress work', () => {
    const store = new MemoryIdempotencyStore({ maxEntries: 2 });
    expect(store.begin('a', 'f', 60_000).status).toBe('started');
    expect(store.begin('b', 'f', 60_000).status).toBe('started');
    expect(store.begin('c', 'f', 60_000)).toEqual({ status: 'full' });
    store.complete('a', { data: null });
    expect(store.begin('c', 'f', 60_000).status).toBe('started');
    expect(store.begin('b', 'f', 60_000).status).toBe('in-progress');
    expect(store.begin('a', 'f', 60_000).status).toBe('full');
    store.abandon('b');
    store.clear();
    expect(store.size).toBe(0);
    expect(() => new MemoryIdempotencyStore({ maxEntries: 0 })).toThrow();
  });
});

describe('rate limit and serial dispatch primitives', () => {
  const context = (
    subject: string,
    tenant?: string,
  ): ActionRateLimitContext => ({
    identity: { subject, ...(tenant ? { tenant } : {}) },
    action: { group: 'g', action: 'a', version: null, idempotent: false },
    request: {},
  });

  it('limits per tenant and subject within a fixed window and bounds keys', () => {
    let now = 0;
    const limit = createFixedWindowRateLimit({
      limit: 2,
      windowMs: 1000,
      maxKeys: 2,
      now: () => now,
    });
    expect(limit(context('a'))).toBe(true);
    expect(limit(context('a'))).toBe(true);
    expect(limit(context('a'))).toBe(false);
    expect(limit(context('a', 't2'))).toBe(true);
    expect(limit(context('b'))).toBe(false);
    now = 1000;
    expect(limit(context('a'))).toBe(true);
    expect(limit(context('b'))).toBe(true);
    limit.clear();
    expect(() => createFixedWindowRateLimit({ limit: 0 })).toThrow();
  });

  it('runs one holder per key in FIFO order with bounded, abortable waiting', async () => {
    const mutex = new KeyedMutex(1);
    const signal = new AbortController().signal;
    const order: string[] = [];
    const first = await mutex.acquire('k', signal);
    const second = mutex.acquire('k', signal).then((release) => {
      order.push('second');
      return release;
    });
    await expect(mutex.acquire('k', signal)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const other = await mutex.acquire('other', signal);
    order.push('other');
    first();
    first();
    (await second)();
    other();
    expect(order).toEqual(['other', 'second']);
    expect(mutex.activeKeys).toBe(0);
    const holder = await mutex.acquire('k', signal);
    const controller = new AbortController();
    const waiting = mutex.acquire('k', controller.signal);
    controller.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    holder();
    expect(mutex.activeKeys).toBe(0);
  });
});

describe('errors, results and schemas', () => {
  it('builds bounded public errors with stable codes and statuses', () => {
    const error = ActionError.validation(
      'Bad',
      [{ path: ['a', 0], message: 'x'.repeat(900) }],
      'FIELD',
    );
    expect(error.getStatus()).toBe(400);
    expect(error.issues?.[0]?.message).toHaveLength(500);
    expect(error.getResponse()).toMatchObject({
      code: 'VALIDATION',
      reason: 'FIELD',
    });
    expect(ActionError.forbidden().getStatus()).toBe(403);
    expect(ActionError.unauthenticated().getStatus()).toBe(401);
    expect(ActionError.notFound().getStatus()).toBe(404);
    expect(ActionError.conflict().getStatus()).toBe(409);
    expect(ActionError.rateLimited().getStatus()).toBe(429);
    expect(new ActionError('TIMEOUT').getStatus()).toBe(504);
    expect(() => new ActionError('NOPE' as 'INTERNAL')).toThrow();
    expect(() => new ActionError('INTERNAL', 'x', { status: 200 })).toThrow();
    expect(
      () => new ActionError('INTERNAL', 'x', { reason: 'lower' }),
    ).toThrow();
  });

  it.each([
    [400, 'VALIDATION'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'VALIDATION'],
    [418, 'VALIDATION'],
    [429, 'RATE_LIMITED'],
    [502, 'INTERNAL'],
    [504, 'TIMEOUT'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });

  it('accepts only safe same-origin redirects and bounded notifications', () => {
    for (const location of ['/cart', '/a?b=c#d'])
      expect(isSafeRedirect(location)).toBe(true);
    for (const location of [
      '',
      'cart',
      '//evil.example',
      '/\\evil',
      'https://evil.example',
      '/a\nb',
      `/${'a'.repeat(2048)}`,
    ])
      expect(isSafeRedirect(location)).toBe(false);
    expect(() => redirectTo('//evil.example')).toThrow('same-origin');
    expect(redirectTo('/x').redirect).toEqual({ location: '/x' });
    expect(
      withNotifications(1, { level: 'info', message: 'Hi' }).notifications,
    ).toEqual([{ level: 'info', message: 'Hi' }]);
    expect(() =>
      withNotifications(1, { level: 'loud' as 'info', message: 'Hi' }),
    ).toThrow();
    expect(() =>
      ActionResult.of(1, {
        notifications: Array.from({ length: 11 }, () => ({
          level: 'info' as const,
          message: 'x',
        })),
      }),
    ).toThrow();
    const result = ActionResult.of({ a: 1 }, { redirect: '/next' }).withData(
      'x',
    );
    expect(result).toMatchObject({
      data: 'x',
      redirect: { location: '/next' },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('runs Zod, safeParse-only and parse-only schemas', async () => {
    const schema = z.object({ n: z.number().int() });
    await expect(runSchema(schema, { n: 1, extra: true })).resolves.toEqual({
      ok: true,
      value: { n: 1 },
    });
    const failed = await runSchema(schema, { n: 'x' });
    expect(failed).toMatchObject({ ok: false, issues: [{ path: ['n'] }] });
    await expect(
      runSchema(
        {
          safeParse: () => ({
            success: false,
            error: { issues: [{ path: [{ key: 'deep' }], message: 'bad' }] },
          }),
        },
        1,
      ),
    ).resolves.toEqual({
      ok: false,
      issues: [{ path: ['deep'], message: 'bad' }],
    });
    await expect(
      runSchema(
        {
          parse: () => {
            throw new Error('boom');
          },
        },
        1,
      ),
    ).resolves.toEqual({
      ok: false,
      issues: [{ path: [], message: 'Invalid value' }],
    });
    await expect(
      runSchema({ parse: (value: unknown) => String(value) }, 5),
    ).resolves.toEqual({ ok: true, value: '5' });
  });
});
