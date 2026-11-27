import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { installLiveAlpine } from '../packages/alpine/src/index.js';
import type {
  AlpineHost,
  AlpineMagicUtilities,
  LiveClientBridge,
  LiveMagic,
} from '../packages/alpine/src/index.js';
import { propertyRuns } from './support/property-runs.js';

/**
 * Property-based fuzzing of the Alpine `$live` bridge (SEC-004): state keys
 * Alpine expressions read, names and values passed to `set`, `entangle`,
 * `call`, `dispatch` and `on`, the `nestvexa:event` details delivered to `on`
 * callbacks, and the element ancestry that decides which component owns
 * `$live`. Invariants: only `Error`s are thrown, `Object.prototype` is never
 * polluted, `$live.state` cannot be written, non-primitive values never
 * reach the client through `entangle`, event payloads arrive as private
 * copies and only for valid names, and `$live` never crosses an island or
 * leaves an `nv:ignore` subtree.
 */
const runs = propertyRuns(300);

/** Minimal element with the ancestry and event APIs the bridge uses. */
class TestElement extends EventTarget {
  parentElement: TestElement | null = null;
  isConnected = true;
  ownerDocument: { defaultView: EventTarget | null } | null = null;
  readonly attributes = new Set<string>();
  closest(selector: string): TestElement | null {
    if (selector !== '[data-nv-component]')
      throw new Error('Unexpected selector');
    if (this.attributes.has('data-nv-component')) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

const polluted = () =>
  ['polluted', 'isAdmin'].some(
    (name) => Reflect.get(Object.prototype, name) !== undefined,
  );
const primitive = (value: unknown) =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

function fixture() {
  let callback:
    | ((element: HTMLElement, utilities: AlpineMagicUtilities) => unknown)
    | undefined;
  const alpine: AlpineHost = {
    version: '3.17.5',
    magic(_name, value) {
      callback = value;
    },
    reactive: (value) => value,
  };
  const values = new Map<string, unknown>([
    ['count', 0],
    ['title', 'hello'],
  ]);
  const calls: { kind: string; name: unknown; value?: unknown }[] = [];
  const client: LiveClientBridge = {
    async call(_element, action) {
      calls.push({ kind: 'call', name: action });
    },
    get(_element, name) {
      calls.push({ kind: 'get', name });
      if (!values.has(name)) throw new Error('Unknown public state field');
      return values.get(name);
    },
    set(_element, name, value) {
      calls.push({ kind: 'set', name, value });
      values.set(name, value);
    },
    dispatch(name, payload) {
      calls.push({ kind: 'dispatch', name, value: payload });
    },
  };
  installLiveAlpine(alpine, client);
  const view = new EventTarget();
  const component = new TestElement();
  component.attributes.add('data-nv-component');
  const local = new TestElement();
  local.attributes.add('nv:ignore');
  local.parentElement = component;
  const element = new TestElement();
  element.parentElement = local;
  element.ownerDocument = { defaultView: view };
  const effects: (() => void)[] = [];
  const utilities: AlpineMagicUtilities = {
    cleanup: () => undefined,
    effect(run) {
      effects.push(run);
      run();
    },
    interceptor: (run) => (initialValue) => ({
      initialize: (data: Record<string, unknown>, path: string) =>
        run(
          initialValue,
          () => data[path],
          (value) => {
            data[path] = value;
          },
          path,
          path,
        ),
    }),
  };
  const magic = (target: TestElement = element): LiveMagic => {
    if (!callback) throw new Error('Plugin not installed');
    return callback(target.asElement(), utilities) as LiveMagic;
  };
  return { magic, values, calls, view, effects, element };
}

const name = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.stringMatching(/^[a-z][a-z0-9:.-]{0,10}$/),
  fc.constantFrom(
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    '_x_dataStack',
    '__v_skip',
    '$data',
    'count',
    'title',
    'a'.repeat(65),
  ),
);
const hostileValue = fc.oneof(
  fc.anything({ maxDepth: 3 }),
  fc.constant(JSON.parse('{"__proto__":{"polluted":1}}')),
  fc.constant(JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}')),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -0),
);

describe('Alpine $live bridge', () => {
  it('reads state only for plain names and never allows writes', () => {
    fc.assert(
      fc.property(
        fc.oneof(name, fc.constant(Symbol.iterator), fc.constant(Symbol('x'))),
        hostileValue,
        (key, value) => {
          const f = fixture();
          const state = f.magic().state;
          f.calls.length = 0;
          const plain = typeof key === 'string' && /^[A-Za-z]/.test(key);
          try {
            const read: unknown = Reflect.get(state, key);
            if (!plain) expect(read).toBeUndefined();
          } catch (error) {
            // An unknown plain field is the client's refusal, as an Error.
            expect(plain).toBe(true);
            expect(error).toBeInstanceOf(Error);
          }
          // Internal and symbol keys never reach the client.
          if (!plain) expect(f.calls).toEqual([]);
          expect(typeof Reflect.has(state, key)).toBe('boolean');
          for (const write of [
            () => Reflect.set(state, key, value),
            () => Reflect.deleteProperty(state, key),
            () => Reflect.defineProperty(state, key, { value }),
            () => Reflect.setPrototypeOf(state, { polluted: 1 }),
          ])
            expect(write).toThrow(/read-only/);
          expect(f.calls.some((call) => call.kind === 'set')).toBe(false);
          expect(Object.getPrototypeOf(state)).toBeNull();
          expect(polluted()).toBe(false);
        },
      ),
      runs,
    );
  });

  it('entangle stages primitives only and restores the last value on anything else', () => {
    fc.assert(
      fc.property(hostileValue, (value) => {
        const f = fixture();
        const binding = f.magic().entangle('title') as {
          initialize(data: Record<string, unknown>, path: string): unknown;
        };
        const data: Record<string, unknown> = {};
        expect(binding.initialize(data, 'title')).toBe('hello');
        f.calls.length = 0;
        data['title'] = value;
        let thrown: unknown;
        try {
          for (const run of f.effects) run();
        } catch (error) {
          thrown = error;
        }
        const staged = f.calls.filter((call) => call.kind === 'set');
        if (primitive(value)) {
          expect(thrown).toBeUndefined();
          if (!Object.is(value, 'hello'))
            expect(staged).toEqual([{ kind: 'set', name: 'title', value }]);
        } else {
          expect(thrown).toBeInstanceOf(Error);
          expect(staged).toEqual([]);
          // Alpine's copy is put back to the last committed value.
          expect(data['title']).toBe('hello');
        }
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });

  it('accepts only Live event names for on() and delivers private copies of matching events', () => {
    fc.assert(
      fc.property(
        name,
        // Mostly the subscribed name itself (`same`), so deliveries happen.
        fc.oneof(
          { arbitrary: fc.constant('same' as const), weight: 3 },
          { arbitrary: name, weight: 1 },
          { arbitrary: fc.anything({ maxDepth: 1 }), weight: 1 },
        ),
        hostileValue,
        fc.oneof(fc.string({ maxLength: 10 }), fc.anything({ maxDepth: 1 })),
        (subscribed, pick, payload, source) => {
          const delivered = pick === 'same' ? subscribed : pick;
          const f = fixture();
          const live = f.magic();
          const received: { payload: unknown; source: unknown }[] = [];
          const valid = /^[a-z][a-z0-9:.-]{0,63}$/.test(subscribed);
          let unsubscribe: (() => void) | undefined;
          try {
            unsubscribe = live.on(subscribed, (data, from) =>
              received.push({ payload: data, source: from }),
            );
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
          expect(unsubscribe !== undefined).toBe(valid);
          // fast-check data is structured-cloneable; the bridge copies it.
          structuredClone(payload);
          const dispatch = (detail: unknown) =>
            f.view.dispatchEvent(new CustomEvent('nestvexa:event', { detail }));
          dispatch({ name: delivered, payload, source });
          // Malformed details are ignored.
          for (const detail of [
            null,
            'name',
            [subscribed],
            { name: [subscribed] },
          ])
            dispatch(detail);
          const matches = valid && delivered === subscribed;
          expect(received.length).toBe(matches ? 1 : 0);
          for (const entry of received) {
            expect(entry.payload).toEqual(payload);
            if (typeof payload === 'object' && payload !== null)
              expect(entry.payload).not.toBe(payload);
            expect(
              typeof entry.source === 'string' || entry.source === null,
            ).toBe(true);
          }
          unsubscribe?.();
          dispatch({ name: subscribed, payload: 1, source: null });
          expect(received.length).toBe(matches ? 1 : 0);
          expect(polluted()).toBe(false);
        },
      ),
      runs,
    );
  });

  it('forwards call, set and dispatch inputs to the client without interpreting them', async () => {
    await fc.assert(
      fc.asyncProperty(name, hostileValue, async (target, value) => {
        const f = fixture();
        const live = f.magic();
        f.calls.length = 0;
        await live.call(target);
        live.set(target, value as string);
        live.dispatch(target, value);
        // The bridge adds nothing and drops nothing; the Live client and
        // the server validate names and values (tests/client-*.test.ts).
        expect(f.calls.map((call) => call.kind)).toEqual([
          'call',
          'set',
          'dispatch',
        ]);
        for (const call of f.calls) expect(call.name).toBe(target);
        expect(polluted()).toBe(false);
      }),
      runs,
    );
  });

  it('binds $live only inside an nv:ignore subtree of a component, never across an island', () => {
    const attribute = fc.constantFrom(
      'data-nv-component',
      'nv:ignore',
      'data-nv-island',
      'data-other',
    );
    fc.assert(
      fc.property(
        fc.array(fc.array(attribute, { maxLength: 2 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (chain) => {
          const f = fixture();
          // chain[0] is the outermost ancestor; the last entry is the element.
          let parent: TestElement | null = null;
          const nodes = chain.map((attributes) => {
            const node = new TestElement();
            for (const name of attributes) node.attributes.add(name);
            node.parentElement = parent;
            node.ownerDocument = { defaultView: f.view };
            parent = node;
            return node;
          });
          const target = nodes[nodes.length - 1];
          if (!target) return;
          // The reference rule: the closest component ancestor (or self),
          // an nv:ignore below it on the path, and no island on the path.
          let ownerIndex = -1;
          for (const [index, node] of nodes.entries())
            if (node.attributes.has('data-nv-component')) ownerIndex = index;
          const path = ownerIndex < 0 ? [] : nodes.slice(ownerIndex + 1);
          const expected =
            ownerIndex >= 0 &&
            path.some((node) => node.attributes.has('nv:ignore')) &&
            !path.some((node) => node.attributes.has('data-nv-island'));
          let bound = false;
          try {
            f.magic(target);
            bound = true;
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
          }
          expect(bound).toBe(expected);
        },
      ),
      runs,
    );
  });
});
