import 'reflect-metadata';
import { runInNewContext } from 'node:vm';
import {
  Body,
  Get,
  Header,
  HttpCode,
  Redirect,
  Render,
  SetMetadata,
  Sse,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  Version,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  Computed,
  LiveComponent,
  State,
  definition,
} from '../packages/live/src/metadata.js';
import { prepareComputed } from '../packages/live/src/computed.js';

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Missing resolver');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('Missing rejecter');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}
function setup<T extends object>(type: new () => T, clock?: () => number) {
  const instance = new type();
  const clear = prepareComputed(instance, definition(type), clock);
  return { instance, clear };
}

describe('computed metadata boundaries', () => {
  it.each([
    ['guard', UseGuards({ canActivate: () => false })],
    ['pipe', UsePipes({ transform: (value: unknown) => value })],
    [
      'interceptor',
      UseInterceptors({
        intercept(context, next) {
          void context;
          return next.handle();
        },
      }),
    ],
    [
      'filter',
      UseFilters({
        catch(error: unknown) {
          void error;
        },
      }),
    ],
    ['route', Get('ignored')],
    ['header', Header('X-Test', 'ignored')],
    ['status', HttpCode(202)],
    ['template', Render('ignored')],
    ['redirect', Redirect('/safe')],
    ['sse', Sse('ignored')],
    ['version', Version('1')],
  ] as const)(
    'rejects ineffective Nest %s decorators on computed methods',
    (name, decorate) => {
      void name;
      @LiveComponent({ name: 'decorated-computed', view: 'unused' })
      class Derived {
        @Computed({ async: true }) async summary() {
          return 1;
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        Derived.prototype,
        'summary',
      );
      if (!descriptor) throw new Error('Missing computed descriptor');
      decorate(Derived.prototype, 'summary', descriptor);
      expect(() => definition(Derived)).toThrow('cannot use Nest');
    },
  );
  it('rejects Nest parameter extraction on a computed method even with default arguments', () => {
    @LiveComponent({ name: 'parameter-computed', view: 'unused' })
    class Derived {
      @Computed({ async: true }) async summary(@Body() input: unknown = null) {
        void input;
        return 1;
      }
    }
    expect(() => definition(Derived)).toThrow('cannot use Nest');
  });
  it('retains unrelated application metadata on a computed read', () => {
    @LiveComponent({ name: 'custom-metadata', view: 'unused' })
    class Derived {
      @Computed({ async: true })
      @SetMetadata('sample:label', 'allowed')
      async summary() {
        return 1;
      }
    }
    expect(definition(Derived).computed.has('summary')).toBe(true);
  });
  it.each([
    null,
    [],
    Object.create({ cache: true }),
    { unknown: true },
    { async: 'yes' },
    { cache: 1 },
    { ttl: 0 },
    { ttl: 60_001 },
    { ttl: NaN },
    { ttl: Infinity },
    { ttl: 0.5 },
    { timeoutMs: 1 },
    { async: true, timeoutMs: 0 },
    { async: true, timeoutMs: 300_001 },
    { async: true, timeoutMs: NaN },
    { async: true, timeoutMs: 1.5 },
    { cache: false, ttl: 1 },
    { cache: false, dependencies: [] },
    { dependencies: 'count' },
    { dependencies: ['count', 'count'] },
    { dependencies: ['constructor'] },
    { dependencies: ['a.b'] },
    { dependencies: [null] },
    { dependencies: Array.from({ length: 65 }, (_, index) => 'f' + index) },
  ])('rejects malformed or ineffective options %#', (options) => {
    expect(() => Reflect.apply(Computed, undefined, [options])).toThrow();
  });
  it('rejects option and dependency getters without invoking them', () => {
    let calls = 0;
    const options = Object.defineProperty({}, 'cache', {
      get() {
        calls++;
        return true;
      },
    });
    expect(() => Reflect.apply(Computed, undefined, [options])).toThrow();
    const dependencies = Object.defineProperty([], '0', {
      enumerable: true,
      get() {
        calls++;
        return 'count';
      },
    });
    expect(() =>
      Reflect.apply(Computed, undefined, [{ dependencies }]),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it('requires explicit async methods, no setters and no declared method arguments', () => {
    expect(() =>
      Computed()({}, 'total', {
        value() {
          return 1;
        },
      }),
    ).toThrow('getter');
    expect(() =>
      Computed({ async: true })({}, 'total', {
        get() {
          return 1;
        },
      }),
    ).toThrow('method');
    expect(() =>
      Computed()({}, 'total', {
        get() {
          return 1;
        },
        set(value: number) {
          void value;
        },
      }),
    ).toThrow('getter');
    expect(() =>
      Computed({ async: true })({}, 'total', {
        value(input: unknown) {
          void input;
          return Promise.resolve(1);
        },
      }),
    ).toThrow('zero-argument');
  });
  it('copies dependency metadata and validates declared state', () => {
    const dependencies = ['count'];
    @LiveComponent({ name: 'derived', view: 'derived' })
    class Derived {
      @State() count = 1;
      @Computed({ dependencies }) get total() {
        return this.count * 2;
      }
    }
    dependencies.push('privateField');
    const entry = definition(Derived).computed.get('total');
    expect(entry?.dependencies).toEqual(['count']);
    expect(Object.isFrozen(entry?.dependencies)).toBe(true);
    @LiveComponent({ name: 'unknown-dependency', view: 'unused' })
    class Unknown {
      @Computed({ dependencies: ['privateField'] }) get total() {
        return 0;
      }
    }
    expect(() => definition(Unknown)).toThrow('declared state');
  });
  it('requires decorated overrides and never evaluates an overriding getter at registration', () => {
    let calls = 0;
    @LiveComponent({ name: 'base-computed', view: 'unused' })
    class Base {
      @Computed() get total() {
        return 1;
      }
    }
    class Bad extends Base {
      override get total() {
        calls++;
        return 2;
      }
    }
    expect(() => definition(Bad)).toThrow('without @Computed');
    expect(calls).toBe(0);
    class Good extends Base {
      @Computed() override get total() {
        return 3;
      }
    }
    expect(setup(Good).instance.total).toBe(3);
    expect(setup(Base).instance.total).toBe(1);
  });
  it('rejects dual computed/action exposure and action IDs matching computed names', () => {
    @LiveComponent({ name: 'dual', view: 'unused' })
    class Dual {
      @Action() @Computed({ async: true }) async total() {
        return 1;
      }
    }
    expect(() => definition(Dual)).toThrow('Duplicate live member');
    @LiveComponent({ name: 'alias', view: 'unused' })
    class Alias {
      @Computed() get total() {
        return 1;
      }
      @Action({ id: 'total' }) other() {}
    }
    expect(() => definition(Alias)).toThrow('Duplicate live member');
  });
  it('bounds per-instance computed entries', () => {
    class Many {}
    LiveComponent({ name: 'many', view: 'unused' })(Many);
    for (let index = 0; index < 65; index++) {
      const name = 'derived' + index;
      const descriptor = {
        configurable: true,
        get() {
          return index;
        },
      };
      Object.defineProperty(Many.prototype, name, descriptor);
      Computed()(Many.prototype, name, descriptor);
    }
    expect(() => definition(Many)).toThrow('At most 64');
  });
});

describe('instance-local derived values', () => {
  it('distinguishes nested signed zero, positive zero and cache-marker-like strings', () => {
    @LiveComponent({ name: 'signed-zero', view: 'unused' })
    class Derived {
      @State() data: { values: (number | string)[] } = { values: [-0] };
      calls = 0;
      @Computed() get detail() {
        const value = this.data.values[0];
        return {
          kind: typeof value,
          negative: Object.is(value, -0),
          calls: ++this.calls,
        };
      }
    }
    const { instance } = setup(Derived);
    expect(instance.detail).toEqual({
      kind: 'number',
      negative: true,
      calls: 1,
    });
    instance.data.values[0] = 0;
    expect(instance.detail).toEqual({
      kind: 'number',
      negative: false,
      calls: 2,
    });
    instance.data.values[0] = 'n-0';
    expect(instance.detail).toEqual({
      kind: 'string',
      negative: false,
      calls: 3,
    });
    instance.data.values[0] = 'sn-0';
    expect(instance.detail).toEqual({
      kind: 'string',
      negative: false,
      calls: 4,
    });
    expect(instance.detail.calls).toBe(4);
  });
  it('also rejects cross-realm promise getters without leaving their rejection unhandled', async () => {
    @LiveComponent({ name: 'foreign-promise', view: 'unused' })
    class Wrong {
      @Computed() get output(): unknown {
        return runInNewContext('Promise.reject(new Error("fixture"))');
      }
    }
    expect(() => setup(Wrong).instance.output).toThrow('synchronous');
    await Promise.resolve();
  });
  it('does not resurrect an older key after a failed evaluation', () => {
    @LiveComponent({ name: 'failed-key', view: 'unused' })
    class Derived {
      @State() count = 0;
      calls = 0;
      @Computed() get total() {
        this.calls++;
        if (this.count === 1) throw new Error('fixture');
        return this.calls;
      }
    }
    const { instance } = setup(Derived);
    expect(instance.total).toBe(1);
    instance.count = 1;
    expect(() => instance.total).toThrow('fixture');
    instance.count = 0;
    expect(instance.total).toBe(3);
  });
  it('memoizes by all public state by default, including deep mutation, and returns detached JSON', () => {
    @LiveComponent({ name: 'derived', view: 'unused' })
    class Derived {
      @State() count = 1;
      @State() nested = { tags: ['first'] };
      calls = 0;
      @Computed() get total() {
        this.calls++;
        return { count: this.count, tags: this.nested.tags };
      }
    }
    const { instance, clear } = setup(Derived);
    const first = instance.total;
    first.tags.push('local');
    expect(instance.total.tags).toEqual(['first']);
    expect(instance.calls).toBe(1);
    instance.count++;
    expect(instance.total.count).toBe(2);
    instance.nested.tags.push('second');
    expect(instance.total.tags).toEqual(['first', 'second']);
    expect(instance.calls).toBe(3);
    clear();
    expect(instance.total.count).toBe(2);
    expect(instance.calls).toBe(4);
  });
  it('uses explicit dependencies and optional TTL without caching another instance', () => {
    @LiveComponent({ name: 'derived', view: 'unused' })
    class Derived {
      @State() count = 1;
      @State() unrelated = 0;
      calls = 0;
      @Computed({ dependencies: ['count'], ttl: 10 }) get total() {
        return this.count + ++this.calls;
      }
    }
    let clock = 0;
    const first = setup(Derived, () => clock).instance;
    const second = setup(Derived, () => clock).instance;
    expect(first.total).toBe(2);
    first.unrelated++;
    clock = 9;
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    clock = 10;
    expect(first.total).toBe(3);
    first.count++;
    expect(first.total).toBe(5);
    expect(second.calls).toBe(1);
  });
  it('does not memoize cache:false readers', () => {
    @LiveComponent({ name: 'uncached', view: 'unused' })
    class Uncached {
      calls = 0;
      @Computed({ cache: false }) get total() {
        return ++this.calls;
      }
    }
    const { instance } = setup(Uncached);
    expect(instance.total).toBe(1);
    expect(instance.total).toBe(2);
  });
  it('rejects dependency accessors without running them', () => {
    @LiveComponent({ name: 'derived', view: 'unused' })
    class Derived {
      @State() count = 1;
      @Computed() get total() {
        return this.count;
      }
    }
    const { instance } = setup(Derived);
    let calls = 0;
    Object.defineProperty(instance, 'count', {
      get() {
        calls++;
        return 1;
      },
    });
    expect(() => instance.total).toThrow('data field');
    expect(calls).toBe(0);
  });
  it('detects synchronous computed cycles', () => {
    @LiveComponent({ name: 'cycle', view: 'unused' })
    class Cycle {
      @Computed() get a(): number {
        return this.b;
      }
      @Computed() get b(): number {
        return this.a;
      }
    }
    expect(() => setup(Cycle).instance.a).toThrow('Circular');
  });
  it('rejects promise getters without leaving a rejected promise unhandled', async () => {
    @LiveComponent({ name: 'promise-getter', view: 'unused' })
    class Wrong {
      @Computed() get value() {
        return Promise.reject(new Error('fixture failure'));
      }
    }
    expect(() => setup(Wrong).instance.value).toThrow('synchronous');
    await Promise.resolve();
  });
  it.each([
    undefined,
    new Date(),
    1n,
    new Map(),
    new Set(),
    NaN,
    Infinity,
    new Uint8Array(1),
    { constructor: 'unsafe' },
  ])('rejects unsupported computed JSON %#', (value) => {
    @LiveComponent({ name: 'invalid-json', view: 'unused' })
    class Wrong {
      @Computed() get output() {
        return value;
      }
    }
    expect(() => setup(Wrong).instance.output).toThrow();
  });
  it('rejects result getters and cycles without reading accessors', () => {
    let calls = 0;
    let value: object = Object.defineProperty({}, 'leak', {
      enumerable: true,
      get() {
        calls++;
        return 'private';
      },
    });
    @LiveComponent({ name: 'invalid-json', view: 'unused' })
    class Wrong {
      @Computed() get output() {
        return value;
      }
    }
    const { instance } = setup(Wrong);
    expect(() => instance.output).toThrow('data');
    expect(calls).toBe(0);
    const cycle: { self?: object } = {};
    cycle.self = cycle;
    value = cycle;
    expect(() => instance.output).toThrow('Cyclic');
  });
  it('rejects own fields shadowing computed metadata', () => {
    @LiveComponent({ name: 'shadow', view: 'unused' })
    class Shadow {
      @Computed() get total() {
        return 1;
      }
    }
    const instance = new Shadow();
    Object.defineProperty(instance, 'total', { value: 2 });
    expect(() => prepareComputed(instance, definition(Shadow))).toThrow(
      'shadowed',
    );
  });
});

describe('explicit async computed methods', () => {
  it('does not repopulate a cleared stage from a late pending result', async () => {
    const old = deferred<number>();
    @LiveComponent({ name: 'cleared-stage', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true }) async total() {
        return ++this.calls === 1 ? old.promise : 2;
      }
    }
    const { instance, clear } = setup(Derived);
    const first = instance.total();
    clear();
    expect(await instance.total()).toBe(2);
    old.resolve(1);
    expect(await first).toBe(1);
    expect(await instance.total()).toBe(2);
    expect(instance.calls).toBe(2);
  });
  it('bounds an asynchronous dependency cycle and releases both deadlines', async () => {
    vi.useFakeTimers();
    @LiveComponent({ name: 'async-cycle', view: 'unused' })
    class Derived {
      @Computed({ async: true, timeoutMs: 25 }) async a(): Promise<number> {
        await Promise.resolve();
        return this.b();
      }
      @Computed({ async: true, timeoutMs: 25 }) async b(): Promise<number> {
        await Promise.resolve();
        return this.a();
      }
    }
    const { instance } = setup(Derived);
    const failed = expect(instance.a()).rejects.toMatchObject({
      code: 'COMPUTED_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(25);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces pending reads and gives every caller detached data', async () => {
    const pending = deferred<{ tags: string[] }>();
    @LiveComponent({ name: 'async-derived', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true }) async details() {
        this.calls++;
        return pending.promise;
      }
    }
    const { instance } = setup(Derived);
    const first = instance.details();
    const second = instance.details();
    expect(instance.calls).toBe(1);
    pending.resolve({ tags: ['safe'] });
    const result = await first;
    result.tags.push('changed');
    expect(await second).toEqual({ tags: ['safe'] });
    expect(await instance.details()).toEqual({ tags: ['safe'] });
    expect(instance.calls).toBe(1);
    expect(() => Reflect.apply(instance.details, instance, [1])).toThrow(
      'arguments',
    );
  });
  it('does not let an older pending result poison the current dependency key', async () => {
    const pending = [deferred<number>(), deferred<number>()];
    @LiveComponent({ name: 'async-derived', view: 'unused' })
    class Derived {
      @State() count = 0;
      calls = 0;
      @Computed({ async: true }) async total() {
        this.calls++;
        return pending[this.count]?.promise;
      }
    }
    const { instance } = setup(Derived);
    const first = instance.total();
    instance.count = 1;
    const second = instance.total();
    pending[1]?.resolve(20);
    expect(await second).toBe(20);
    pending[0]?.resolve(10);
    expect(await first).toBe(10);
    expect(await instance.total()).toBe(20);
    expect(instance.calls).toBe(2);
  });
  it('starts TTL at successful completion and keeps a single pending operation', async () => {
    const pending = deferred<number>();
    let clock = 0;
    @LiveComponent({ name: 'async-ttl', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true, ttl: 10 }) async total() {
        this.calls++;
        return pending.promise;
      }
    }
    const { instance } = setup(Derived, () => clock);
    const first = instance.total();
    clock = 50;
    const second = instance.total();
    pending.resolve(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
    clock = 59;
    expect(await instance.total()).toBe(7);
    expect(instance.calls).toBe(1);
    clock = 60;
    expect(await instance.total()).toBe(7);
    expect(instance.calls).toBe(2);
  });
  it('evicts failures and never caches invalid output', async () => {
    @LiveComponent({ name: 'async-failure', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true }) async total() {
        if (++this.calls === 1) throw new Error('fixture');
        return this.calls === 2 ? undefined : 3;
      }
    }
    const { instance } = setup(Derived);
    await expect(instance.total()).rejects.toThrow('fixture');
    await expect(instance.total()).rejects.toThrow();
    expect(await instance.total()).toBe(3);
    expect(await instance.total()).toBe(3);
    expect(instance.calls).toBe(3);
  });
  it('bounds never-settling async work, clears timers and ignores its late result', async () => {
    vi.useFakeTimers();
    const pending = deferred<number>();
    @LiveComponent({ name: 'async-deadline', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true, timeoutMs: 25 }) async total() {
        return ++this.calls === 1 ? pending.promise : 2;
      }
    }
    const { instance } = setup(Derived);
    const first = expect(instance.total()).rejects.toMatchObject({
      code: 'COMPUTED_TIMEOUT',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(25);
    await first;
    expect(vi.getTimerCount()).toBe(0);
    expect(await instance.total()).toBe(2);
    pending.resolve(1);
    await Promise.resolve();
    expect(await instance.total()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports independent uncached async reads', async () => {
    @LiveComponent({ name: 'async-uncached', view: 'unused' })
    class Derived {
      calls = 0;
      @Computed({ async: true, cache: false }) async total() {
        return ++this.calls;
      }
    }
    const { instance } = setup(Derived);
    expect(await Promise.all([instance.total(), instance.total()])).toEqual([
      1, 2,
    ]);
  });
});
