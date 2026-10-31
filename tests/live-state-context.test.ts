import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  LiveComponent,
  State,
  definition,
} from '../packages/live/src/metadata.js';
import {
  Session,
  Url,
  collectStateContext,
  hydrateStateContext,
  persistStateContext,
  urlStateEffects,
} from '../packages/live/src/state-context.js';
import type { StateContextDefinition } from '../packages/live/src/state-context.js';

const binding = 'authoritative-session-tenant-a-user-a';
function setup<T extends object>(type: new () => T) {
  const states = definition(type).states;
  const context = collectStateContext(type, states);
  const instance = new type();
  return {
    states,
    context,
    instance,
    hydrate: (request: object, identity = binding, now = 1000) =>
      hydrateStateContext(
        instance,
        'test-component',
        context,
        states,
        request,
        identity,
        now,
      ),
    persist: (request: object, identity = binding, now = 1000) =>
      persistStateContext(
        instance,
        'test-component',
        context,
        request,
        identity,
        now,
      ),
  };
}

@LiveComponent({ name: 'context-sample', view: 'unused' })
class Sample {
  @Url({ key: 'q', except: '' })
  @Session({ key: 'search', ttl: 100 })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length < 100,
  })
  query = '';

  @Url({ history: 'push', except: 1 })
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1,
  })
  page = 1;

  @Url()
  @State({ writable: true })
  active = false;

  @Session()
  @State()
  draft = { fields: ['initial'] };
}

describe('URL/session state metadata', () => {
  it.each([
    null,
    [],
    Object.create({ key: 'other' }),
    { other: true },
    { key: '' },
    { key: '__proto__' },
    { key: 'constructor' },
    { key: 'prototype' },
    { key: 'a.b' },
    { key: 'x'.repeat(65) },
  ])('rejects invalid shared options %j', (value) => {
    expect(() => Reflect.apply(Url, undefined, [value])).toThrow();
    expect(() => Reflect.apply(Session, undefined, [value])).toThrow();
  });
  it.each([
    { history: 'back' },
    { except: null },
    { except: {} },
    { except: NaN },
    { except: Infinity },
  ])('rejects invalid URL options %j', (value) =>
    expect(() => Reflect.apply(Url, undefined, [value])).toThrow(),
  );
  it.each([
    { ttl: 0 },
    { ttl: -1 },
    { ttl: 1.5 },
    { ttl: NaN },
    { ttl: Infinity },
    { ttl: 86_400_001 },
  ])('rejects invalid session options %j', (value) =>
    expect(() => Reflect.apply(Session, undefined, [value])).toThrow(),
  );
  it('does not execute option getters', () => {
    const getter = vi.fn(() => 'q');
    const options = Object.defineProperty({}, 'key', {
      get: getter,
      enumerable: true,
    });
    expect(() => Url(options)).toThrow('own data');
    expect(() => Session(options)).toThrow('own data');
    expect(getter).not.toHaveBeenCalled();
  });
  it('copies options and retains inherited fields with explicit derived overrides', () => {
    const options = { key: 'original', ttl: 20 };
    @LiveComponent({ name: 'base-context', view: 'unused' })
    class Base {
      @Session(options) @State() value = 'base';
      @Url({ key: 'q' }) @State({ writable: true }) query = '';
    }
    options.key = 'changed';
    class Child extends Base {
      @Url({ key: 'search' }) @State({ writable: true }) override query = '';
    }
    const base = collectStateContext(Base, definition(Base).states);
    const child = collectStateContext(Child, definition(Child).states);
    expect(base.session.get('value')).toEqual({ key: 'original', ttl: 20 });
    expect(base.url.get('query')?.key).toBe('q');
    expect(child.url.get('query')?.key).toBe('search');
    expect(child.session.get('value')).toEqual(base.session.get('value'));
  });
  it('rejects duplicate aliases, missing state, and URL locked state', () => {
    @LiveComponent({ name: 'duplicate-url', view: 'unused' })
    class Duplicate {
      @Url({ key: 'q' }) @State({ writable: true }) first = '';
      @Url({ key: 'q' }) @State({ writable: true }) second = '';
    }
    expect(() =>
      collectStateContext(Duplicate, definition(Duplicate).states),
    ).toThrow('Duplicate');
    class Missing {
      @Session() value = '';
    }
    expect(() => collectStateContext(Missing, new Map())).toThrow(
      'requires @State',
    );
    @LiveComponent({ name: 'locked-url', view: 'unused' })
    class Locked {
      @Url() @State() value = '';
    }
    expect(() =>
      collectStateContext(Locked, definition(Locked).states),
    ).toThrow('writable:true');
  });
  it('rejects duplicate field decorators, symbols, and unsafe property names', () => {
    const prototype = {};
    Url()(prototype, 'query');
    expect(() => Url()(prototype, 'query')).toThrow('Duplicate');
    expect(() => Session()(prototype, Symbol('field'))).toThrow('name');
    expect(() => Url()(prototype, 'constructor')).toThrow('name');
  });
  it('bounds decorated field counts', () => {
    class Many {}
    const states = new Map();
    for (let index = 0; index < 65; index++) {
      Url()(Many.prototype, `field${index}`);
      states.set(`field${index}`, { writable: true });
    }
    expect(() => collectStateContext(Many, states)).toThrow('64');
  });
});

describe('URL mount hydration', () => {
  it('uses explicit aliases and strict primitives; unknown keys never assign state', async () => {
    const sample = setup(Sample);
    await sample.hydrate({
      url: '/board?q=%D8%A8%D8%AD%D8%AB&page=2&active=true&constructor=bad&private=secret',
      session: {},
    });
    expect(sample.instance.query).toBe('بحث');
    expect(sample.instance.page).toBe(2);
    expect(sample.instance.active).toBe(true);
    expect(Object.hasOwn(sample.instance, 'private')).toBe(false);
    expect(sample.instance.constructor).toBe(Sample);
  });
  it('prefers originalUrl on hosts with rewritten route URLs', async () => {
    const sample = setup(Sample);
    await sample.hydrate({
      originalUrl: '/app/board?q=original',
      url: '/rewritten?q=ignored',
      session: {},
    });
    expect(sample.instance.query).toBe('original');
  });
  it.each([
    '/board?page=2&page=3',
    '/board?page=NaN',
    '/board?page=Infinity',
    '/board?page=1e999',
    '/board?page=0x10',
    '/board?page=+2',
    '/board?page=02',
    '/board?page=',
    '/board?active=1',
    '/board?active=FALSE',
    '/board?q=%ZZ',
    '/board?q=%FF',
    '/board#q=hidden',
    '//attacker.test/?q=bad',
    'https://attacker.test/?q=bad',
    '/board\\evil?q=bad',
    '/board\n?q=bad',
    `/board?q=${'x'.repeat(8192)}`,
    `/board?${Array.from({ length: 129 }, (_, index) => `x${index}=1`).join('&')}`,
  ])('rejects invalid/oversized query %s atomically', async (url) => {
    const sample = setup(Sample);
    await expect(sample.hydrate({ url, session: {} })).rejects.toMatchObject({
      code: 'INVALID_URL_STATE',
    });
    expect(sample.instance.query).toBe('');
    expect(sample.instance.page).toBe(1);
  });
  it('validates all values before assigning any state, including async schemas', async () => {
    const sample = setup(Sample);
    await expect(
      sample.hydrate({ url: '/board?q=valid&page=-2', session: {} }),
    ).rejects.toMatchObject({ code: 'STATE_VALIDATION' });
    expect(sample.instance.query).toBe('');
    @LiveComponent({ name: 'async-url', view: 'unused' })
    class Async {
      @Url()
      @State({ writable: true, validate: async (value) => value === 'allowed' })
      query = '';
    }
    const asyncSample = setup(Async);
    await expect(
      asyncSample.hydrate({ url: '/?query=denied' }),
    ).rejects.toMatchObject({ code: 'STATE_VALIDATION' });
    await asyncSample.hydrate({ url: '/?query=allowed' });
    expect(asyncSample.instance.query).toBe('allowed');
  });
  it('does not require URL/session capabilities when no decorators exist', async () => {
    @LiveComponent({ name: 'no-context', view: 'unused' })
    class None {
      @State() value = 1;
    }
    const sample = setup(None);
    await sample.hydrate({});
    sample.persist({});
    expect(urlStateEffects(sample.instance, sample.context)).toEqual([]);
  });
  it('rejects mismatched except types and object URL fields explicitly', async () => {
    @LiveComponent({ name: 'bad-except', view: 'unused' })
    class BadExcept {
      @Url({ except: false }) @State({ writable: true }) value = '';
    }
    await expect(setup(BadExcept).hydrate({ url: '/' })).rejects.toThrow(
      'except must match',
    );
    @LiveComponent({ name: 'object-url', view: 'unused' })
    class ObjectUrl {
      @Url() @State({ writable: true }) value = {};
    }
    await expect(setup(ObjectUrl).hydrate({ url: '/' })).rejects.toThrow(
      'initialized strings',
    );
  });
  it('rejects getters and immutable fields without invoking them', async () => {
    const sample = setup(Sample);
    const getter = vi.fn(() => 'secret');
    Object.defineProperty(sample.instance, 'query', { get: getter });
    await expect(sample.hydrate({ url: '/', session: {} })).rejects.toThrow(
      'own writable data',
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('emits bounded safe key/value history effects and removes except values', () => {
    const sample = setup(Sample);
    expect(urlStateEffects(sample.instance, sample.context)).toEqual([
      { key: 'q', value: null, history: 'replace' },
      { key: 'page', value: null, history: 'push' },
      { key: 'active', value: 'false', history: 'replace' },
    ]);
    sample.instance.query = '</script>&?#';
    expect(urlStateEffects(sample.instance, sample.context)[0]?.value).toBe(
      '</script>&?#',
    );
    sample.instance.query = 'x'.repeat(8193);
    expect(() => urlStateEffects(sample.instance, sample.context)).toThrow(
      'Invalid URL/session',
    );
  });
});

describe('host-owned session state', () => {
  it('clones stored values, scopes authoritative identity/component and honors expiry', async () => {
    const session = {};
    const sample = setup(Sample);
    sample.instance.query = 'remembered';
    sample.instance.draft.fields.push('saved');
    sample.persist({ session });
    sample.instance.draft.fields.push('later');
    const restored = setup(Sample);
    await restored.hydrate({ url: '/', session }, binding, 1050);
    expect(restored.instance.query).toBe('remembered');
    expect(restored.instance.draft.fields).toEqual(['initial', 'saved']);
    restored.instance.draft.fields.push('detached');
    const other = setup(Sample);
    await other.hydrate(
      { url: '/', session },
      'authoritative-session-tenant-b-user-a',
      1050,
    );
    expect(other.instance.query).toBe('');
    expect(other.instance.draft.fields).toEqual(['initial']);
    const expired = setup(Sample);
    await expired.hydrate({ url: '/', session }, binding, 1100);
    expect(expired.instance.query).toBe('');
    const instance = new Sample();
    await hydrateStateContext(
      instance,
      'different-component',
      sample.context,
      sample.states,
      { url: '/', session },
      binding,
      1050,
    );
    expect(instance.query).toBe('');
    expect(JSON.stringify(session)).not.toContain(binding);
  });
  it('query explicitly overrides restored session values after validating both boundaries', async () => {
    const sample = setup(Sample);
    const session = {};
    sample.instance.query = 'old';
    sample.persist({ session });
    const restored = setup(Sample);
    await restored.hydrate({ url: '/?q=new', session });
    expect(restored.instance.query).toBe('new');
  });
  it('fails closed when session middleware is missing', async () => {
    const sample = setup(Sample);
    await expect(sample.hydrate({ url: '/' })).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
      status: 503,
    });
    expect(() => sample.persist({})).toThrow('Invalid URL/session');
  });
  it('refuses forged invalid bindings and clocks', async () => {
    const sample = setup(Sample);
    await expect(
      sample.hydrate({ url: '/', session: {} }, 'short'),
    ).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
    expect(() => sample.persist({ session: {} }, binding, NaN)).toThrow(
      'clock',
    );
    await expect(
      sample.hydrate({ url: '/', session: {} }, binding, -1),
    ).rejects.toThrow('clock');
  });
  it.each([
    null,
    {},
    { expiresAt: 2000 },
    { value: 'stolen', expiresAt: '2000' },
    { value: 'stolen', expiresAt: Infinity },
    { value: 'stolen', expiresAt: -1 },
    { value: 'stolen', expiresAt: 2000, extra: 1 },
  ])('rejects corrupt stored record %j', async (record) => {
    const sample = setup(Sample);
    const session: Record<string, unknown> = {};
    sample.persist({ session });
    const key = Object.keys(session).find((candidate) =>
      candidate.endsWith(':search'),
    );
    if (!key) throw new Error('Missing session slot');
    session[key] = record;
    await expect(
      setup(Sample).hydrate({ url: '/', session }),
    ).rejects.toThrow();
  });
  it('does not execute corrupt session getters or accept class/prototype payloads', async () => {
    const sample = setup(Sample);
    const session: Record<string, unknown> = {};
    sample.persist({ session });
    const key = Object.keys(session)[0];
    if (!key) throw new Error('Missing session slot');
    const getter = vi.fn(() => ({ value: 'stolen', expiresAt: 2000 }));
    Object.defineProperty(session, key, { get: getter });
    await expect(
      setup(Sample).hydrate({ url: '/', session }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION_STATE' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects unsafe stored state and oversized aggregate persistence before writes', () => {
    const sample = setup(Sample);
    sample.instance.query = 'x'.repeat(65_536);
    const session = {};
    expect(() => sample.persist({ session })).toThrow();
    expect(session).toEqual({});
  });
  it('preflights unwritable session slots before changing other fields', () => {
    const sample = setup(Sample);
    const session: Record<string, unknown> = {};
    sample.persist({ session });
    const before = JSON.stringify(session);
    const key = Object.keys(session).find((candidate) =>
      candidate.endsWith(':draft'),
    );
    if (!key) throw new Error('Missing draft slot');
    Object.defineProperty(session, key, { writable: false });
    sample.instance.query = 'new';
    expect(() => sample.persist({ session })).toThrow();
    expect(JSON.stringify(session)).toBe(before);
    expect(() =>
      sample.persist({ session: Object.preventExtensions({}) }),
    ).toThrow();
  });
  it('validates restored values with declared state validators', async () => {
    const sample = setup(Sample);
    const session: Record<string, unknown> = {};
    sample.persist({ session });
    const key = Object.keys(session).find((candidate) =>
      candidate.endsWith(':search'),
    );
    if (!key) throw new Error('Missing search slot');
    session[key] = { value: 42, expiresAt: 2000 };
    await expect(
      setup(Sample).hydrate({ url: '/', session }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION_STATE' });
  });
  it('does not share validator-held objects with hydrated component state', async () => {
    let captured: unknown;
    @LiveComponent({ name: 'captured-session', view: 'unused' })
    class Captured {
      @Session()
      @State({
        writable: true,
        validate(value) {
          captured = value;
          return true;
        },
      })
      draft = { values: ['initial'] };
    }
    const initial = setup(Captured);
    const session = {};
    initial.persist({ session });
    const restored = setup(Captured);
    await restored.hydrate({ session });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(restored.instance.draft).not.toBe(captured);
    expect(Object.isFrozen(restored.instance.draft)).toBe(false);
    restored.instance.draft.values.push('component-only');
    expect(captured).toEqual({ values: ['initial'] });
  });
  it('allows sessions with host-specific prototypes and never serializes their methods', async () => {
    class HostSession {
      save() {
        throw new Error('Not a state field');
      }
    }
    const session = new HostSession();
    const sample = setup(Sample);
    sample.instance.query = 'allowed';
    sample.persist({ session });
    const restored = setup(Sample);
    await restored.hydrate({ url: '/', session });
    expect(restored.instance.query).toBe('allowed');
  });
  it('accepts a deliberately empty collected definition without request URL or identity checks', async () => {
    const context: StateContextDefinition = {
      url: new Map(),
      session: new Map(),
    };
    await hydrateStateContext({}, 'unused', context, new Map(), {}, '', 1000);
    persistStateContext({}, 'unused', context, {}, '', 1000);
  });
});
