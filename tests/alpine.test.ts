import { describe, expect, it, vi } from 'vitest';
import { installLiveAlpine } from '../packages/alpine/src/index.js';
import type {
  AlpineHost,
  AlpineMagicUtilities,
  LiveClientBridge,
  LiveMagic,
} from '../packages/alpine/src/index.js';

/** Minimal event/ancestry fixture for adapter unit tests; real Alpine DOM behavior is tested in Playwright. */
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
function fixture() {
  let callback:
    | ((element: HTMLElement, utilities: AlpineMagicUtilities) => unknown)
    | undefined;
  let signal: { revision: number } | undefined;
  const magic = vi.fn(
    (
      name: string,
      value: (element: HTMLElement, utilities: AlpineMagicUtilities) => unknown,
    ) => {
      expect(name).toBe('live');
      callback = value;
    },
  );
  const alpine: AlpineHost = {
    version: '3.17.5',
    magic,
    reactive(value) {
      signal = value;
      return value;
    },
  };
  const values = new Map<string, unknown>([['count', 0]]);
  const client: LiveClientBridge = {
    call: vi.fn(async () => undefined),
    get: vi.fn((_element, name) => {
      if (!values.has(name)) throw new Error('Unknown public state field');
      return values.get(name);
    }),
    set: vi.fn((_element, name, value) => {
      values.set(name, value);
    }),
  };
  const component = new TestElement();
  component.attributes.add('data-nv-component');
  const local = new TestElement();
  local.attributes.add('nv:ignore');
  local.parentElement = component;
  const element = new TestElement();
  element.parentElement = local;
  const cleanups: (() => void)[] = [];
  // Minimal stand-ins for Alpine's element-bound effect and data interceptor:
  // effects run immediately and again on flush(); disposed ones stop.
  const effects: (() => void)[] = [];
  let effectsActive = true;
  const reactivity: Pick<AlpineMagicUtilities, 'effect' | 'interceptor'> = {
    effect(run) {
      effects.push(run);
      run();
    },
    interceptor: (run) => (initialValue) => ({
      _x_interceptor: true,
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
  function flush(): void {
    if (effectsActive) for (const run of effects) run();
  }
  function facade(target = element, utilities = reactivity): LiveMagic {
    if (!callback) throw new Error('Plugin not installed');
    return callback(target.asElement(), {
      cleanup: (fn) => cleanups.push(fn),
      ...utilities,
    }) as LiveMagic;
  }
  return {
    alpine,
    client,
    magic,
    component,
    local,
    element,
    cleanups,
    facade,
    flush,
    values,
    stopEffects: () => {
      effectsActive = false;
    },
    revision: () => signal?.revision,
  };
}

describe('Alpine Live adapter', () => {
  it('registers without starting Alpine and coalesces repeated installation', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    installLiveAlpine(f.alpine, f.client);
    expect(f.magic).toHaveBeenCalledTimes(1);
    expect(() => installLiveAlpine(f.alpine, { ...f.client })).toThrow(
      'another Live client',
    );
  });
  it.each(['3.16.9', '3.18.0', '4.0.0', '3.17.5-beta.1'])(
    'rejects unsupported version %s',
    (version) => {
      const f = fixture();
      expect(() =>
        installLiveAlpine({ ...f.alpine, version }, f.client),
      ).toThrow('3.17.x');
    },
  );
  it('caches a facade and delegates scoped get/set/call', async () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    expect(f.facade()).toBe(magic);
    expect(f.cleanups).toHaveLength(1);
    expect(magic.get('count')).toBe(0);
    magic.set('count', 3);
    expect(magic.get('count')).toBe(3);
    expect(f.revision()).toBe(1);
    await magic.call('increment');
    expect(f.client.call).toHaveBeenCalledWith(
      f.element.asElement(),
      'increment',
    );
    f.component.dispatchEvent(new Event('nestvexa:updated'));
    expect(f.revision()).toBe(2);
  });
  it('unsubscribes and invalidates stale references when Alpine cleans up', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    for (const cleanup of f.cleanups) cleanup();
    f.component.dispatchEvent(new Event('nestvexa:updated'));
    expect(f.revision()).toBe(0);
    expect(() => magic.get('count')).toThrow('no longer attached');
    expect(() => magic.set('count', 1)).toThrow('no longer attached');
    expect(() => magic.call('increment')).toThrow('no longer attached');
  });
  it('rejects an unowned or nonignored element and framework-island crossings', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const unowned = new TestElement();
    expect(() => f.facade(unowned)).toThrow('owning Live component');
    f.local.attributes.delete('nv:ignore');
    expect(() => f.facade()).toThrow('nv:ignore');
    f.local.attributes.add('nv:ignore');
    f.local.attributes.add('data-nv-island');
    expect(() => f.facade()).toThrow('island boundary');
  });
  it('rejects detached and reparented cached references', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    f.element.isConnected = false;
    expect(() => magic.get('count')).toThrow('no longer attached');
    f.element.isConnected = true;
    const another = new TestElement();
    another.attributes.add('data-nv-component');
    f.local.parentElement = another;
    expect(() => magic.get('count')).toThrow('no longer attached');
  });
  it('$live.on delivers private payload copies and stops after unsubscribe or cleanup', () => {
    const f = fixture();
    const view = new EventTarget();
    f.element.ownerDocument = { defaultView: view };
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    const received: [unknown, string | null][] = [];
    const unsubscribe = magic.on('saved', (payload, source) => {
      received.push([payload, source]);
      if (payload && typeof payload === 'object')
        Reflect.set(payload, 'id', 99);
    });
    const other: unknown[] = [];
    magic.on('saved', (payload) => other.push(payload));
    const detail = Object.freeze({
      name: 'saved',
      payload: { id: 1 },
      source: 'todo',
    });
    view.dispatchEvent(new CustomEvent('nestvexa:event', { detail }));
    view.dispatchEvent(
      new CustomEvent('nestvexa:event', {
        detail: { name: 'other', payload: 2, source: null },
      }),
    );
    expect(received).toEqual([[{ id: 99 }, 'todo']]);
    // Each subscriber gets its own copy; the shared detail is untouched.
    expect(other).toEqual([{ id: 1 }]);
    expect(detail.payload).toEqual({ id: 1 });
    unsubscribe();
    unsubscribe();
    view.dispatchEvent(new CustomEvent('nestvexa:event', { detail }));
    expect(received).toHaveLength(1);
    expect(other).toHaveLength(2);
    for (const cleanup of f.cleanups) cleanup();
    view.dispatchEvent(new CustomEvent('nestvexa:event', { detail }));
    expect(other).toHaveLength(2);
    expect(() => magic.on('saved', () => undefined)).toThrow(
      'no longer attached',
    );
  });
  it('$live.on validates names, callbacks, windows and its subscription bound', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    expect(() => magic.on('saved', () => undefined)).toThrow('attached window');
    f.element.ownerDocument = { defaultView: new EventTarget() };
    for (const name of ['Saved', 'a b', '', 'x'.repeat(65), '__proto__'])
      expect(() => magic.on(name, () => undefined)).toThrow('event name');
    expect(() =>
      magic.on('saved', 'alert(1)' as unknown as () => void),
    ).toThrow('callback');
    for (let index = 0; index < 32; index++) magic.on('saved', () => undefined);
    expect(() => magic.on('saved', () => undefined)).toThrow('limit');
  });
  it('propagates failed calls without inventing retries', async () => {
    const f = fixture();
    const call = vi.fn(async () => {
      throw new Error('failed');
    });
    installLiveAlpine(f.alpine, { ...f.client, call });
    await expect(f.facade().call('increment')).rejects.toThrow('failed');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('$live.state is a reactive read-only view of public state', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    expect(magic.state['count']).toBe(0);
    expect('count' in magic.state).toBe(true);
    expect('missing' in magic.state).toBe(false);
    expect(() => magic.state['missing']).toThrow('Unknown public state');
    // Alpine/evaluator probes of internal keys never reach the client.
    for (const key of ['_x_interceptor', '__v_skip', '$data'])
      expect(Reflect.get(magic.state, key)).toBeUndefined();
    expect(Reflect.get(magic.state, Symbol.iterator)).toBeUndefined();
    expect(() => Reflect.set(magic.state, 'count', 1)).toThrow('read-only');
    expect(() => Reflect.deleteProperty(magic.state, 'count')).toThrow(
      'read-only',
    );
    expect(() =>
      Object.defineProperty(magic.state, 'count', { value: 1 }),
    ).toThrow('read-only');
    expect(f.client.set).not.toHaveBeenCalled();
    magic.set('count', 4);
    expect(magic.state['count']).toBe(4);
    for (const cleanup of f.cleanups) cleanup();
    expect(() => magic.state['count']).toThrow('no longer attached');
  });
  it('$live.entangle stages Alpine writes as drafts and applies committed values', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    const magic = f.facade();
    const data: Record<string, unknown> = {};
    const binding = magic.entangle('count') as {
      initialize(data: Record<string, unknown>, path: string): unknown;
    };
    data['count'] = binding.initialize(data, 'count');
    expect(data['count']).toBe(0);
    expect(f.client.set).not.toHaveBeenCalled();
    // Alpine -> Live: a local write stages a draft once.
    data['count'] = 5;
    f.flush();
    f.flush();
    expect(f.client.set).toHaveBeenCalledTimes(1);
    expect(f.client.set).toHaveBeenCalledWith(
      f.element.asElement(),
      'count',
      5,
    );
    expect(f.revision()).toBe(1);
    // Live -> Alpine: a committed server value replaces the local value
    // without echoing it back as a new draft.
    f.values.set('count', 9);
    f.component.dispatchEvent(new Event('nestvexa:updated'));
    f.flush();
    expect(data['count']).toBe(9);
    expect(f.client.set).toHaveBeenCalledTimes(1);
    // Non-primitive Alpine values are reverted and rejected.
    data['count'] = { nested: true };
    expect(() => f.flush()).toThrow('primitive values only');
    expect(data['count']).toBe(9);
    // After Alpine cleanup nothing is staged any more.
    for (const cleanup of f.cleanups) cleanup();
    data['count'] = 11;
    f.flush();
    expect(f.client.set).toHaveBeenCalledTimes(1);
  });
  it('$live.entangle requires primitive fields and Alpine reactivity APIs', () => {
    const f = fixture();
    installLiveAlpine(f.alpine, f.client);
    f.values.set('items', ['a']);
    expect(() => f.facade().entangle('items')).toThrow('primitive public');
    expect(() => f.facade().entangle('missing')).toThrow('Unknown public');
    const bare = new TestElement();
    bare.parentElement = f.local;
    expect(() => f.facade(bare, {}).entangle('count')).toThrow(
      'interceptor and effect',
    );
  });
});
