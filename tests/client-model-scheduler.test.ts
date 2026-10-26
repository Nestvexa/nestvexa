import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelScheduler } from '../packages/client/dist/model-scheduler.js';

/** Structural DOM fixture: these tests cover timing, not browser event integration. */
function model(field = 'query', name = 'nv:model.live') {
  let connected = true;
  let disabled = false;
  let owner: Element | null = null;
  let parent: Element | null = null;
  const attributes = new Map([[name, field]]);
  const value = {
    get isConnected() {
      return connected;
    },
    get attributes() {
      return Array.from(attributes, ([name, value]) => ({ name, value }));
    },
    matches: (selector: string) => selector === ':disabled' && disabled,
    get parentElement() {
      return parent;
    },
    closest: (selector: string): Element | null => {
      if (selector === '[data-nv-component]') return owner;
      for (
        let current: Element | null = value;
        current;
        current = current.parentElement
      )
        if (
          selector === '[data-nv-island]' &&
          current.hasAttribute('data-nv-island')
        )
          return current;
      return null;
    },
    contains: () => false,
    getAttribute: (key: string) => attributes.get(key) ?? null,
    hasAttribute: (key: string) => attributes.has(key),
  } as unknown as Element;
  return {
    value,
    attributes,
    disconnect: () => {
      connected = false;
    },
    disable: () => {
      disabled = true;
    },
    reparent: (next: Element) => {
      owner = next;
      parent = next;
    },
    moveWithinOwner: (next: Element) => {
      parent = next;
    },
  };
}
function root(includes: (element: Element) => boolean): Element {
  return { contains: includes } as unknown as Element;
}
afterEach(() => vi.useRealTimers());

describe('model scheduler', () => {
  it('invokes immediately by default without retaining idle records', () => {
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    for (let index = 0; index < 1100; index++)
      scheduler.schedule(model().value, 'query');
    expect(invoke).toHaveBeenCalledTimes(1100);
    scheduler.dispose();
  });

  it('resets debounce and releases the record after firing', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    scheduler.schedule(input.value, 'query', { debounceMs: 300 });
    vi.advanceTimersByTime(200);
    scheduler.schedule(input.value, 'query', { debounceMs: 300 });
    vi.advanceTimersByTime(299);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(input.value, 'query');
    for (let index = 0; index < 1100; index++) {
      scheduler.schedule(model().value, 'query', { debounceMs: 1 });
      vi.advanceTimersByTime(1);
    }
    expect(invoke).toHaveBeenCalledTimes(1101);
    scheduler.dispose();
  });

  it('throttles on the leading edge with no trailing call or window extension', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    scheduler.schedule(input.value, 'query', { throttleMs: 100 });
    vi.advanceTimersByTime(99);
    scheduler.schedule(input.value, 'query', { throttleMs: 100 });
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduler.schedule(input.value, 'query', { throttleMs: 100 });
    expect(invoke).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(invoke).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('keeps element timers independent and supports field/all cancellation', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const first = model();
    const second = model('title');
    scheduler.schedule(first.value, 'query', { debounceMs: 100 });
    scheduler.schedule(second.value, 'title', { debounceMs: 100 });
    scheduler.cancel(first.value, 'other');
    scheduler.cancel(first.value, 'query');
    vi.advanceTimersByTime(100);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(second.value, 'title');
    scheduler.schedule(second.value, 'title', { debounceMs: 100 });
    scheduler.cancel(second.value);
    vi.advanceTimersByTime(100);
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it.each(['detach', 'disable', 'owner', 'attribute', 'remove', 'duplicate'])(
    'cancels delayed synchronization after %s changes',
    (change) => {
      vi.useFakeTimers();
      const invoke = vi.fn(async () => {});
      const scheduler = createModelScheduler({ invoke });
      const input = model();
      scheduler.schedule(input.value, 'query', { debounceMs: 100 });
      if (change === 'detach') input.disconnect();
      if (change === 'disable') input.disable();
      if (change === 'owner') input.reparent(model().value);
      if (change === 'attribute')
        input.attributes.set('nv:model.live', 'other');
      if (change === 'remove') input.attributes.clear();
      if (change === 'duplicate')
        input.attributes.set('nv:model.blur', 'query');
      vi.advanceTimersByTime(100);
      expect(invoke).not.toHaveBeenCalled();
      scheduler.dispose();
    },
  );

  it('cancels when the directive name changes and accepts a newly scheduled configuration', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    scheduler.schedule(input.value, 'query', { debounceMs: 100 });
    input.attributes.clear();
    input.attributes.set('nv:model.blur', 'query');
    vi.advanceTimersByTime(100);
    expect(invoke).not.toHaveBeenCalled();
    scheduler.schedule(input.value, 'query', { debounceMs: 50 });
    vi.advanceTimersByTime(50);
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it.each(['nv:ignore', 'data-nv-island'])(
    'cancels delayed models moved into a %s subtree under the same owner',
    (boundary) => {
      vi.useFakeTimers();
      const invoke = vi.fn(async () => {});
      const scheduler = createModelScheduler({ invoke });
      const component = model();
      const input = model();
      input.reparent(component.value);
      scheduler.schedule(input.value, 'query', { debounceMs: 10 });
      const subtree = model();
      subtree.attributes.set(boundary, '');
      subtree.reparent(component.value);
      input.moveWithinOwner(subtree.value);
      vi.advanceTimersByTime(10);
      expect(invoke).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      scheduler.dispose();
    },
  );

  it('prunes pending models when the Live owner moves inside an island', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const component = model();
    const input = model();
    input.reparent(component.value);
    scheduler.schedule(input.value, 'query', { debounceMs: 10 });
    const island = model();
    island.attributes.set('data-nv-island', 'chart');
    component.moveWithinOwner(island.value);
    scheduler.prune(root(() => true));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10);
    expect(invoke).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it.each(['nv:ignore', 'data-nv-island'])(
    'rejects new immediate and delayed scheduling inside a %s boundary',
    (boundary) => {
      vi.useFakeTimers();
      const invoke = vi.fn(async () => {});
      const scheduler = createModelScheduler({ invoke });
      const input = model();
      input.attributes.set(boundary, '');
      scheduler.schedule(input.value, 'query');
      scheduler.schedule(input.value, 'query', { debounceMs: 10 });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10);
      expect(invoke).not.toHaveBeenCalled();
      scheduler.dispose();
    },
  );

  it('replaces pending timing options and cancels debounce when switching to immediate', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    scheduler.schedule(input.value, 'query', { debounceMs: 100 });
    scheduler.schedule(input.value, 'query', { debounceMs: 10 });
    vi.advanceTimersByTime(10);
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduler.schedule(input.value, 'query', { debounceMs: 100 });
    scheduler.schedule(input.value, 'query');
    vi.advanceTimersByTime(100);
    expect(invoke).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('prunes nodes outside the client root while retaining the root itself', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    const other = model();
    scheduler.schedule(input.value, 'query', { debounceMs: 10 });
    scheduler.schedule(other.value, 'query', { debounceMs: 10 });
    scheduler.prune(input.value);
    vi.advanceTimersByTime(10);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(input.value, 'query');
    scheduler.schedule(input.value, 'query', { debounceMs: 10 });
    scheduler.prune(root(() => false));
    vi.advanceTimersByTime(10);
    expect(invoke).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('bounds pending records, prunes stale records and releases throttle records', () => {
    vi.useFakeTimers();
    const scheduler = createModelScheduler({ invoke: async () => {} });
    const inputs = Array.from({ length: 1000 }, () => model());
    for (const input of inputs)
      scheduler.schedule(input.value, 'query', { throttleMs: 10 });
    expect(() =>
      scheduler.schedule(model().value, 'query', { debounceMs: 10 }),
    ).toThrow('capacity');
    inputs[0]?.disconnect();
    expect(() =>
      scheduler.schedule(model().value, 'query', { debounceMs: 10 }),
    ).not.toThrow();
    vi.advanceTimersByTime(10);
    for (let index = 0; index < 1000; index++)
      scheduler.schedule(model().value, 'query', { throttleMs: 10 });
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 60001, 1.5, NaN, Infinity])(
    'rejects invalid intervals %s',
    (interval) => {
      const scheduler = createModelScheduler({ invoke: async () => {} });
      for (const timing of [{ debounceMs: interval }, { throttleMs: interval }])
        expect(() =>
          scheduler.schedule(model().value, 'query', timing),
        ).toThrow('integer');
    },
  );

  it('rejects mixed timing, unsafe fields and mismatched or ambiguous model attributes', () => {
    const scheduler = createModelScheduler({ invoke: async () => {} });
    expect(() =>
      scheduler.schedule(model().value, 'query', {
        debounceMs: 1,
        throttleMs: 1,
      }),
    ).toThrow('combined');
    for (const field of [
      'constructor',
      '__proto__',
      'prototype',
      'user.name',
      'query()',
    ])
      expect(() => scheduler.schedule(model(field).value, field)).toThrow(
        'identifier',
      );
    const input = model();
    expect(() => scheduler.schedule(input.value, 'other')).toThrow('matching');
    input.attributes.clear();
    expect(() => scheduler.schedule(input.value, 'query')).toThrow('matching');
    input.attributes.set('nv:model', 'query');
    input.attributes.set('nv:model.live', 'query');
    expect(() => scheduler.schedule(input.value, 'query')).toThrow('matching');
  });

  it('reports synchronous and rejected invocation failures without retries', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const failure = new Error('network unavailable');
    const invoke = vi.fn((): Promise<void> => {
      throw failure;
    });
    const scheduler = createModelScheduler({ invoke, onError });
    const input = model();
    scheduler.schedule(input.value, 'query');
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, input.value);
    invoke.mockImplementation(() => Promise.reject('unknown failure'));
    scheduler.schedule(input.value, 'query', { debounceMs: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1]?.[0]).toBeInstanceOf(Error);
    scheduler.dispose();
  });

  it('ignores disconnected/disabled nodes and cancels all timers on terminal disposal', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => {});
    const scheduler = createModelScheduler({ invoke });
    const input = model();
    const disabled = model();
    disabled.disable();
    scheduler.schedule(disabled.value, 'query');
    const detached = model();
    detached.disconnect();
    scheduler.schedule(detached.value, 'query');
    scheduler.schedule(input.value, 'query', { debounceMs: 100 });
    scheduler.dispose();
    scheduler.dispose();
    scheduler.schedule(input.value, 'query');
    vi.advanceTimersByTime(100);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
