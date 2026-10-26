import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventDispatcher,
  parseEventDirective,
} from '../packages/client/dist/events.js';

// Minimal EventTarget fixture verifies deterministic filtering/timing, not browser behavior.
function element() {
  const target = new EventTarget();
  let connected = true;
  let disabled = false;
  let owner: Element | null = null;
  const value = Object.assign(target, {
    get isConnected() {
      return connected;
    },
    matches(selector: string) {
      return selector === ':disabled' && disabled;
    },
    closest() {
      return owner;
    },
  });
  Object.defineProperty(value, 'isConnected', { get: () => connected });
  return {
    value: value as unknown as Element,
    disconnect: () => {
      connected = false;
    },
    disable: () => {
      disabled = true;
    },
    reparent: (next: Element) => {
      owner = next;
    },
  };
}
function event(kind = 'click', values: Record<string, unknown> = {}) {
  const value = new Event(kind, { cancelable: true });
  for (const [key, setting] of Object.entries(values))
    Object.defineProperty(value, key, { value: setting });
  return value;
}
afterEach(() => vi.useRealTimers());

describe('closed event grammar', () => {
  it('parses supported filters and flags without expressions', () => {
    expect(
      parseEventDirective(
        'nv:keydown.enter.ctrl.prevent.stop.self.once',
        'save',
      ),
    ).toMatchObject({
      kind: 'keydown',
      action: 'save',
      key: 'Enter',
      ctrl: true,
      prevent: true,
      stop: true,
      self: true,
      once: true,
    });
    expect(parseEventDirective('nv:click.debounce', 'save').debounceMs).toBe(
      250,
    );
    expect(
      parseEventDirective('nv:click.throttle.500ms', 'save').throttleMs,
    ).toBe(500);
    expect(Object.isFrozen(parseEventDirective('nv:click', 'save'))).toBe(true);
  });
  it.each([
    'nv:click.enter',
    'nv:keydown.enter.escape',
    'nv:click.once.once',
    'nv:click.window',
    'nv:submit.document',
    'nv:click.debounce.throttle',
    'nv:click.debounce.0ms',
    'nv:click.throttle.60001ms',
    'nv:click.300ms',
    'nv:click.',
    'nv:input',
    'click',
    'nv:click.debounce.1.5ms',
  ])('rejects unsupported or ambiguous %s', (name) => {
    expect(() => parseEventDirective(name, 'save')).toThrow();
  });
  it.each(['save()', 'constructor', '__proto__', 'group.save', 'x y'])(
    'rejects unregistered action grammar %s',
    (value) => {
      expect(() => parseEventDirective('nv:click', value)).toThrow();
    },
  );
  it.each(['enter', 'escape', 'space', 'tab', 'arrow-up', 'arrow-down'])(
    'accepts keyboard key %s',
    (key) => {
      expect(parseEventDirective(`nv:keydown.${key}`, 'save').key).toBeTypeOf(
        'string',
      );
    },
  );
});

describe('event scheduling and lifecycle', () => {
  it('filters before preventing or stopping, requires selected system modifiers and event type', () => {
    const fixture = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const directive = parseEventDirective(
      'nv:keydown.enter.ctrl.prevent.stop.self',
      'save',
    );
    const rejected = event('keydown', {
      key: 'Escape',
      ctrlKey: true,
      target: fixture.value,
    });
    const stop = vi.spyOn(rejected, 'stopPropagation');
    expect(dispatcher.handle(rejected, fixture.value, directive)).toBe(false);
    expect(rejected.defaultPrevented).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(dispatcher.handle(event('click'), fixture.value, directive)).toBe(
      false,
    );
    expect(
      dispatcher.handle(
        event('keydown', { key: 'Enter', target: fixture.value }),
        fixture.value,
        directive,
      ),
    ).toBe(false);
    expect(
      dispatcher.handle(
        event('keydown', {
          key: 'Enter',
          ctrlKey: true,
          target: new EventTarget(),
        }),
        fixture.value,
        directive,
      ),
    ).toBe(false);
    const accepted = event('keydown', {
      key: 'Enter',
      ctrlKey: true,
      target: fixture.value,
    });
    expect(dispatcher.handle(accepted, fixture.value, directive)).toBe(true);
    expect(accepted.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith(fixture.value, 'save');
    dispatcher.dispose();
  });
  it('invokes once for a directive but independently tracks other actions', () => {
    const fixture = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const first = parseEventDirective('nv:click.once', 'save');
    expect(dispatcher.handle(event(), fixture.value, first)).toBe(true);
    expect(dispatcher.handle(event(), fixture.value, first)).toBe(false);
    expect(
      dispatcher.handle(
        event(),
        fixture.value,
        parseEventDirective('nv:click.once', 'other'),
      ),
    ).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    dispatcher.dispose();
  });
  it('reschedules debounce and consumes once only when it actually invokes', () => {
    vi.useFakeTimers();
    const fixture = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const directive = parseEventDirective(
      'nv:click.once.debounce.300ms',
      'save',
    );
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(true);
    vi.advanceTimersByTime(299);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(false);
    dispatcher.dispose();
  });
  it('throttles leading calls without a trailing request and allows the exact interval boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const directive = parseEventDirective('nv:click.throttle.500ms', 'save');
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(true);
    vi.advanceTimersByTime(499);
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    dispatcher.dispose();
  });
  it('cancels pending work on removal, outside-owner pruning and disposal', () => {
    vi.useFakeTimers();
    const one = element();
    const two = element();
    const three = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const directive = parseEventDirective('nv:click.debounce.1ms', 'save');
    dispatcher.handle(event(), one.value, directive);
    one.disconnect();
    dispatcher.handle(event(), two.value, directive);
    dispatcher.prune({ contains: () => false } as unknown as Element);
    dispatcher.handle(event(), three.value, directive);
    dispatcher.dispose();
    dispatcher.dispose();
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatcher.handle(event(), three.value, directive)).toBe(false);
  });
  it('suppresses disabled and disconnected controls, including controls disabled after debounce', () => {
    vi.useFakeTimers();
    const fixture = element();
    const invoke = vi.fn(async () => {});
    const dispatcher = createEventDispatcher({ invoke });
    const directive = parseEventDirective('nv:click.debounce.1ms', 'save');
    dispatcher.handle(event(), fixture.value, directive);
    fixture.disable();
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatcher.handle(event(), fixture.value, directive)).toBe(false);
    const removed = element();
    removed.disconnect();
    expect(dispatcher.handle(event(), removed.value, directive)).toBe(false);
    dispatcher.dispose();
  });
  it('cancels timers if component ownership or the configured action changes before firing', () => {
    vi.useFakeTimers();
    const first = element();
    const second = element();
    const invoke = vi.fn(async () => {});
    const directive = parseEventDirective('nv:click.debounce.1ms', 'save');
    let configured = 'save';
    Object.defineProperty(second.value, 'getAttribute', {
      value: () => configured,
    });
    const dispatcher = createEventDispatcher({ invoke });
    dispatcher.handle(event(), first.value, directive);
    dispatcher.handle(event(), second.value, directive);
    first.reparent(element().value);
    configured = 'other';
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatcher.handle(event(), second.value, directive)).toBe(false);
    dispatcher.dispose();
  });
  it('reports synchronous and asynchronous failures without retrying an attempted once action', async () => {
    const fixture = element();
    const errors = vi.fn();
    const dispatcher = createEventDispatcher({
      invoke: () => {
        throw new Error('action failure');
      },
      onError: errors,
    });
    const once = parseEventDirective('nv:click.once', 'save');
    dispatcher.handle(event(), fixture.value, once);
    dispatcher.handle(event(), fixture.value, once);
    expect(errors).toHaveBeenCalledTimes(1);
    dispatcher.dispose();
    const asyncDispatcher = createEventDispatcher({
      invoke: async () => {
        throw new Error('network failure');
      },
      onError: errors,
    });
    asyncDispatcher.handle(event(), fixture.value, once);
    await Promise.resolve();
    expect(errors).toHaveBeenCalledTimes(2);
    asyncDispatcher.dispose();
  });
  it('bounds tracked configurations and reclaims detached nodes before admitting new work', () => {
    const invoke = vi.fn(async () => {});
    const errors = vi.fn();
    const dispatcher = createEventDispatcher({ invoke, onError: errors });
    const fixtures = Array.from({ length: 1001 }, element);
    const directive = parseEventDirective('nv:click.once', 'save');
    for (const fixture of fixtures.slice(0, 1000))
      expect(dispatcher.handle(event(), fixture.value, directive)).toBe(true);
    const last = fixtures[1000];
    const first = fixtures[0];
    if (!last || !first) throw new Error('Fixture construction failed');
    expect(dispatcher.handle(event(), last.value, directive)).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    first.disconnect();
    expect(dispatcher.handle(event(), last.value, directive)).toBe(true);
    dispatcher.dispose();
  });
});
