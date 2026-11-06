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
    get: vi.fn((_element, name) => values.get(name)),
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
  function facade(target = element): LiveMagic {
    if (!callback) throw new Error('Plugin not installed');
    return callback(target.asElement(), {
      cleanup: (fn) => cleanups.push(fn),
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
});
