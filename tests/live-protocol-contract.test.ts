import 'reflect-metadata';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BigIntSynthesizer,
  DateSynthesizer,
  LIVE_CAPABILITIES,
  LIVE_ERROR_CODES,
  LIVE_ERROR_SCHEMA,
  LIVE_LIMITS,
  LIVE_PROTOCOL,
  LIVE_REQUEST_SCHEMA,
  LIVE_RESPONSE_SCHEMA,
  LiveComponent,
  LiveProtocolError,
  State,
  Action,
  defineSynthesizer,
  enumSynthesizer,
  liveAbortSignal,
  mapSynthesizer,
  nullableSynthesizer,
  parseLiveCapabilities,
  parseLiveRequest,
  setSynthesizer,
} from '../packages/live/dist/index.js';
import type {
  JsonValue,
  StateSynthesizer,
} from '../packages/live/dist/index.js';
import {
  ActionLocks,
  ActionReplayCache,
} from '../packages/live/dist/action-policy.js';
import { definition } from '../packages/live/dist/metadata.js';

const fixtures = join('tests', 'fixtures', 'live-protocol');
async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtures, name), 'utf8'));
}

/** Seeded xorshift PRNG: fuzz cases are reproducible from the printed seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick<T>(values: readonly T[]): T {
      const value = values[Math.floor(next() * values.length)];
      if (value === undefined) throw new Error('Empty fuzz choice');
      return value;
    },
  };
}
type Random = ReturnType<typeof random>;

/** Subset validator for the keywords the published schemas use. */
function violations(schema: unknown, value: unknown, path = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const rule = schema as Record<string, unknown>;
  const errors: string[] = [];
  const type = rule['type'];
  const isObject =
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'object' && !isObject) return [`${path}: object`];
  if (type === 'array' && !Array.isArray(value)) return [`${path}: array`];
  if (type === 'string' && typeof value !== 'string')
    return [`${path}: string`];
  if (type === 'integer' && !Number.isSafeInteger(value))
    return [`${path}: integer`];
  if ('const' in rule && value !== rule['const']) errors.push(`${path}: const`);
  if (typeof value === 'string') {
    if (
      typeof rule['pattern'] === 'string' &&
      !new RegExp(rule['pattern']).test(value)
    )
      errors.push(`${path}: pattern`);
    if (
      typeof rule['maxLength'] === 'number' &&
      value.length > rule['maxLength']
    )
      errors.push(`${path}: maxLength`);
    if (
      typeof rule['minLength'] === 'number' &&
      value.length < rule['minLength']
    )
      errors.push(`${path}: minLength`);
  }
  if (typeof value === 'number') {
    if (typeof rule['minimum'] === 'number' && value < rule['minimum'])
      errors.push(`${path}: minimum`);
    if (typeof rule['maximum'] === 'number' && value > rule['maximum'])
      errors.push(`${path}: maximum`);
  }
  if (Array.isArray(value) && typeof rule['maxItems'] === 'number')
    if (value.length > rule['maxItems']) errors.push(`${path}: maxItems`);
  if (isObject) {
    const properties = (rule['properties'] ?? {}) as Record<string, unknown>;
    for (const key of (rule['required'] ?? []) as string[])
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, nested] of Object.entries(value)) {
      if (Object.hasOwn(properties, key))
        errors.push(...violations(properties[key], nested, `${path}.${key}`));
      else if (rule['additionalProperties'] === false)
        errors.push(`${path}.${key}: additional`);
      const names = rule['propertyNames'] as { pattern?: string } | undefined;
      if (names?.pattern && !new RegExp(names.pattern).test(key))
        errors.push(`${path}.${key}: propertyNames`);
    }
  }
  return errors;
}

describe('golden protocol fixtures and published schemas', () => {
  it('accepts the golden request in the parser and the schema', async () => {
    const request = await fixture('request.json');
    expect(violations(LIVE_REQUEST_SCHEMA, request)).toEqual([]);
    const parsed = parseLiveRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it('describes the golden response and error bodies', async () => {
    expect(
      violations(LIVE_RESPONSE_SCHEMA, await fixture('response.json')),
    ).toEqual([]);
    expect(violations(LIVE_ERROR_SCHEMA, await fixture('error.json'))).toEqual(
      [],
    );
    expect(
      violations(LIVE_ERROR_SCHEMA, { statusCode: 500, message: 'x' }),
    ).toContain('$.message: additional');
  });
  it('keeps the request schema in lockstep with the strict parser', async () => {
    const request = (await fixture('request.json')) as Record<string, unknown>;
    expect(LIVE_REQUEST_SCHEMA['required']).toEqual([
      'protocol',
      'requestId',
      'snapshot',
      'revision',
      'updates',
    ]);
    for (const key of LIVE_REQUEST_SCHEMA['required'] as string[]) {
      const missing = { ...request };
      delete missing[key];
      expect(violations(LIVE_REQUEST_SCHEMA, missing).length).toBeGreaterThan(
        0,
      );
      expect(() => parseLiveRequest(missing)).toThrow(LiveProtocolError);
    }
    const extra = { ...request, extra: true };
    expect(violations(LIVE_REQUEST_SCHEMA, extra)).toEqual([
      '$.extra: additional',
    ]);
    expect(() => parseLiveRequest(extra)).toThrow(LiveProtocolError);
    const future = { ...request, protocol: 'nestvexa-live/2' };
    expect(violations(LIVE_REQUEST_SCHEMA, future)).toEqual([
      '$.protocol: const',
    ]);
    expect(() => parseLiveRequest(future)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_PROTOCOL', status: 426 }),
    );
    expect(Object.isFrozen(LIVE_REQUEST_SCHEMA)).toBe(true);
    expect(LIVE_PROTOCOL).toBe('nestvexa-live/1');
    expect(LIVE_LIMITS).toEqual({
      maxBytes: 65_536,
      maxDepth: 16,
      maxNodes: 5_000,
    });
  });
});

describe('capability negotiation', () => {
  it('parses known tokens, ignores unknown well-formed tokens and treats absence as none', () => {
    expect(LIVE_CAPABILITIES).toEqual(['renderless-v1']);
    expect([...parseLiveCapabilities(undefined)]).toEqual([]);
    expect([...parseLiveCapabilities('')]).toEqual([]);
    expect([...parseLiveCapabilities('renderless-v1')]).toEqual([
      'renderless-v1',
    ]);
    expect([
      ...parseLiveCapabilities(' future-v2 , renderless-v1,morph-v12 '),
    ]).toEqual(['renderless-v1']);
    expect([...parseLiveCapabilities('renderless-v2')]).toEqual([]);
  });
  it.each([
    ['non-string', ['renderless-v1']],
    ['empty token', 'renderless-v1,'],
    ['missing version', 'renderless'],
    ['uppercase', 'Renderless-v1'],
    ['injection', 'renderless-v1;drop'],
    [
      'too many tokens',
      Array.from({ length: 17 }, (_, i) => `x${i}-v1`).join(','),
    ],
    ['oversized', `a-v1,${'b'.repeat(520)}-v1`],
  ])('rejects a malformed header (%s)', (_label, header) => {
    expect(() => parseLiveCapabilities(header)).toThrow(
      expect.objectContaining({ code: 'INVALID_CAPABILITIES', status: 400 }),
    );
  });
});

function fuzzValue(rng: Random, depth = 0): unknown {
  const kind = rng.int(depth > 3 ? 7 : 11);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rng.next() > 0.5;
    case 2:
      return rng.pick([0, -1, 1.5, Number.NaN, Infinity, 2 ** 60, -0]);
    case 3:
      return rng.pick([
        '',
        'x',
        '__proto__',
        'constructor',
        '\u0000',
        '😀'.repeat(3),
      ]);
    case 4:
      return undefined;
    case 5:
      return Symbol('fuzz');
    case 6:
      return () => 'fn';
    case 7:
      return Array.from({ length: rng.int(4) }, () =>
        fuzzValue(rng, depth + 1),
      );
    case 8:
      return new Date(0);
    case 9: {
      const sparse: unknown[] = [];
      sparse[3] = 1;
      return sparse;
    }
    default: {
      const object: Record<string, unknown> = {};
      for (let index = 0; index < rng.int(4); index++)
        object[rng.pick(['a', 'b', '__proto__', 'prototype', 'x y', 'count'])] =
          fuzzValue(rng, depth + 1);
      return object;
    }
  }
}

describe('parser fuzzing', () => {
  it('only ever returns a frozen request or throws a LiveProtocolError', async () => {
    const golden = (await fixture('request.json')) as Record<string, unknown>;
    const keys = [...Object.keys(golden), 'extra', '__proto__'];
    for (const seed of [1, 7, 42, 2026, 31337]) {
      const rng = random(seed);
      for (let iteration = 0; iteration < 400; iteration++) {
        const candidate: Record<string, unknown> = { ...golden };
        for (let mutation = 0; mutation <= rng.int(3); mutation++) {
          const key = rng.pick(keys);
          if (rng.next() < 0.25) delete candidate[key];
          else
            Object.defineProperty(candidate, key, {
              value: fuzzValue(rng),
              enumerable: rng.next() > 0.05,
              configurable: true,
              writable: true,
            });
        }
        let outcome: unknown;
        try {
          outcome = parseLiveRequest(candidate);
        } catch (error) {
          if (!(error instanceof LiveProtocolError))
            throw new Error(`seed ${seed} iteration ${iteration}`, {
              cause: error,
            });
          expect([400, 413, 426]).toContain(error.status);
          continue;
        }
        expect(Object.isFrozen(outcome)).toBe(true);
        expect(violations(LIVE_REQUEST_SCHEMA, outcome)).toEqual([]);
      }
    }
  });
  it('never executes getters or toJSON while rejecting hostile envelopes', () => {
    let touched = false;
    const hostile = {
      protocol: LIVE_PROTOCOL,
      requestId: 'd85e7c20-72ac-4e71-8baf-210dbe79e912',
      snapshot: Buffer.alloc(32, 7).toString('base64url'),
      revision: 0,
      get updates() {
        touched = true;
        return {};
      },
      toJSON() {
        touched = true;
        return {};
      },
    };
    expect(() => parseLiveRequest(hostile)).toThrow(LiveProtocolError);
    expect(touched).toBe(false);
  });
});

describe('error catalog', () => {
  it('documents every code the Live package can emit, with the emitted status', async () => {
    const root = join('packages', 'live', 'src');
    const found = new Map<string, number>();
    for (const file of await readdir(root)) {
      if (!file.endsWith('.ts')) continue;
      const source = await readFile(join(root, file), 'utf8');
      for (const match of source.matchAll(
        /fail\(\s*(\d{3}),\s*'([A-Z_]+)'\s*\)/g,
      ))
        found.set(match[2] ?? '', Number(match[1]));
      for (const match of source.matchAll(
        /LiveProtocolError\(\s*'([A-Z_]+)',\s*(\d{3})/g,
      ))
        found.set(match[1] ?? '', Number(match[2]));
      for (const match of source.matchAll(
        /LiveProtocolError\(\s*code,\s*(\d{3})/g,
      ))
        found.set(`dynamic:${file}`, Number(match[1]));
    }
    expect(found.size).toBeGreaterThan(35);
    const catalog: Readonly<Record<string, { status: number }>> =
      LIVE_ERROR_CODES;
    for (const [code, status] of found) {
      if (code.startsWith('dynamic:')) continue;
      expect(catalog[code], code).toBeDefined();
      expect(catalog[code]?.status, code).toBe(status);
    }
    for (const code of ['HOOK_TIMEOUT', 'ACTION_TIMEOUT'])
      expect(catalog[code]?.status).toBe(504);
    for (const entry of Object.values(catalog)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

function roundTrip<T>(synthesizer: StateSynthesizer<T>, value: T): T {
  const json = synthesizer.dehydrate(value);
  // Snapshots travel as JSON text; the round trip must survive serialization.
  const restored = synthesizer.hydrate(
    JSON.parse(JSON.stringify(json)) as JsonValue,
  );
  expect(synthesizer.dehydrate(restored)).toEqual(json);
  return restored;
}

describe('typed synthesizers', () => {
  it('round-trips random Date, BigInt, enum, nullable, Set and Map values deterministically', () => {
    const rng = random(99);
    const status = enumSynthesizer(['draft', 'published', 3] as const);
    const nullableText = nullableSynthesizer('string');
    const tags = setSynthesizer();
    const dates = mapSynthesizer({ value: DateSynthesizer });
    for (let index = 0; index < 300; index++) {
      const date = new Date(
        Date.UTC(
          1970 + rng.int(200),
          rng.int(12),
          1 + rng.int(28),
          rng.int(24),
          rng.int(60),
          rng.int(60),
          rng.int(1000),
        ),
      );
      expect(roundTrip(DateSynthesizer, date).getTime()).toBe(date.getTime());
      const big =
        BigInt(rng.int(2 ** 31)) ** BigInt(1 + rng.int(7)) *
        (rng.next() > 0.5 ? -1n : 1n);
      expect(roundTrip(BigIntSynthesizer, big)).toBe(big);
      expect(
        roundTrip(status, rng.pick(['draft', 'published', 3] as const)),
      ).toBeDefined();
      const text = rng.next() > 0.5 ? null : `t${rng.int(1000)}`;
      expect(roundTrip(nullableText, text)).toBe(text);
      const set = new Set(Array.from({ length: rng.int(6) }, () => rng.int(5)));
      expect([...roundTrip(tags, set)]).toEqual([...set]);
      const map = new Map([[`k${rng.int(9)}`, date]]);
      expect(
        roundTrip(dates, map)
          .get([...map.keys()][0] ?? '')
          ?.getTime(),
      ).toBe(date.getTime());
    }
  });
  it('rejects client JSON outside each declared domain', () => {
    const status = enumSynthesizer(['draft', 'published'] as const);
    expect(() => status.hydrate('archived')).toThrow();
    expect(() => status.hydrate(['draft'])).toThrow();
    expect(() => nullableSynthesizer('number').hydrate('1')).toThrow();
    expect(() => setSynthesizer().hydrate([1, 1])).toThrow('duplicates');
    expect(() => setSynthesizer().hydrate([{ nested: true }])).toThrow();
    expect(() => setSynthesizer({ maxItems: 2 }).hydrate([1, 2, 3])).toThrow();
    expect(() =>
      mapSynthesizer().hydrate([
        ['a', 1],
        ['a', 2],
      ]),
    ).toThrow();
    expect(() => mapSynthesizer().hydrate([['__proto__']])).toThrow();
    expect(
      mapSynthesizer()
        .hydrate([['__proto__', 1]])
        .get('__proto__'),
    ).toBe(1);
    expect(() => enumSynthesizer([] as const)).toThrow();
    expect(() => enumSynthesizer(['a', 'a'] as const)).toThrow();
    expect(() =>
      defineSynthesizer({
        name: 'Bad Name',
        dehydrate: () => null,
        hydrate: () => null,
      }),
    ).toThrow();
  });
  it('accepts serializer as the spec alias and validates state defaults at decoration', () => {
    const money = defineSynthesizer<{ cents: number }>({
      name: 'money',
      dehydrate: (value) => value.cents,
      hydrate: (value) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value))
          throw new TypeError('cents');
        return { cents: value };
      },
    });
    @LiveComponent({ name: 'priced', view: 'priced' })
    class Priced {
      @State({ serializer: money }) price = { cents: 100 };
      @State({ default: ['a'] }) tags!: string[];
    }
    const described = definition(Priced);
    expect(described.states.get('price')?.synthesizer?.name).toBe('money');
    expect(described.states.get('tags')?.default).toEqual(['a']);
    expect(() => State({ synthesizer: money, serializer: money })).toThrow(
      'not both',
    );
    expect(() =>
      State({ default: new Map() as unknown as JsonValue }),
    ).toThrow();
    // JavaScript callers can pass an explicit undefined despite the types.
    const explicitUndefined = JSON.parse('{}') as { default: JsonValue };
    Object.defineProperty(explicitUndefined, 'default', {
      value: undefined,
      enumerable: true,
    });
    expect(() => State(explicitUndefined)).toThrow('default');
  });
});

describe('action options and component deadlines', () => {
  it('validates idempotent, concurrency and timeoutMs declarations', () => {
    @LiveComponent({ name: 'checkout', view: 'checkout', timeoutMs: 500 })
    class Checkout {
      @Action({ idempotent: true, concurrency: 'identity' }) pay(): void {}
      @Action() refresh(): void {}
    }
    const described = definition(Checkout);
    expect(described.timeoutMs).toBe(500);
    expect(described.actions.get('pay')).toEqual({
      method: 'pay',
      input: false,
      idempotent: true,
      concurrency: 'identity',
    });
    expect(described.actions.get('refresh')).toEqual({
      method: 'refresh',
      input: false,
    });
    const decorate = (options: object) => () => {
      class Target {
        run(): void {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        Target.prototype,
        'run',
      );
      if (!descriptor) throw new Error('missing');
      Action(options as never)(Target.prototype, 'run', descriptor);
    };
    expect(decorate({ idempotent: 'yes' })).toThrow('idempotent');
    expect(decorate({ concurrency: 'queue' })).toThrow('concurrency');
    expect(decorate({ retries: 3 })).toThrow('known own data');
    for (const timeoutMs of [0, 300_001, 1.5])
      expect(() => LiveComponent({ name: 'x', view: 'x', timeoutMs })).toThrow(
        'timeoutMs',
      );
  });
  it('throws when liveAbortSignal is read outside a running operation', () => {
    expect(() => liveAbortSignal({})).toThrow('only available');
  });
});

describe('replay cache and identity locks', () => {
  const payload = (
    input: JsonValue,
    requestId = 'd85e7c20-72ac-4e71-8baf-210dbe79e912',
  ) =>
    parseLiveRequest({
      protocol: LIVE_PROTOCOL,
      requestId,
      snapshot: Buffer.alloc(32, 7).toString('base64url'),
      revision: 0,
      updates: {},
      input,
    });
  it('replays identical retries, rejects reuse with another payload and isolates identities', () => {
    let now = 1_000;
    const cache = new ActionReplayCache(() => now);
    const binding = 'identity-binding-0001';
    expect(cache.lookup(binding, 'cart', 'pay', payload(1))).toBeUndefined();
    cache.remember(binding, 'cart', 'pay', payload(1), { ok: true });
    expect(cache.lookup(binding, 'cart', 'pay', payload(1))).toEqual({
      ok: true,
      replayed: true,
    });
    expect(() => cache.lookup(binding, 'cart', 'pay', payload(2))).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT', status: 422 }),
    );
    expect(() => cache.lookup(binding, 'cart', 'refund', payload(1))).toThrow(
      'different payload',
    );
    expect(
      cache.lookup('identity-binding-0002', 'cart', 'pay', payload(1)),
    ).toBeUndefined();
    now += 300_001;
    expect(cache.lookup(binding, 'cart', 'pay', payload(1))).toBeUndefined();
  });
  it('bounds memory by evicting the oldest replay', () => {
    const cache = new ActionReplayCache();
    const ids = Array.from(
      { length: 1_001 },
      (_, index) =>
        `d85e7c20-72ac-4e71-8baf-${String(index).padStart(12, '0')}`,
    );
    for (const id of ids)
      cache.remember('b'.repeat(16), 'c', 'a', payload(1, id), {});
    expect(
      cache.lookup('b'.repeat(16), 'c', 'a', payload(1, ids[0])),
    ).toBeUndefined();
    expect(
      cache.lookup('b'.repeat(16), 'c', 'a', payload(1, ids[1_000])),
    ).toBeDefined();
  });
  it('rejects overlapping identity-scoped executions and releases idempotently', () => {
    const locks = new ActionLocks();
    const release = locks.acquire('identity-binding-0001', 'cart', 'pay');
    expect(() => locks.acquire('identity-binding-0001', 'cart', 'pay')).toThrow(
      expect.objectContaining({ code: 'ACTION_BUSY', status: 409 }),
    );
    const other = locks.acquire('identity-binding-0002', 'cart', 'pay');
    release();
    release();
    expect(locks.size).toBe(1);
    other();
    expect(locks.size).toBe(0);
  });
});
