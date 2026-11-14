import { describe, expect, it } from 'vitest';
import { createConfirmationController } from '../packages/client/src/events.js';
import {
  LiveClientError,
  readPath,
  trustedHTML,
} from '../packages/client/src/grammar.js';
import {
  parseEventName,
  parseLiveResponse,
} from '../packages/client/src/protocol.js';
import { applyUrlEffects } from '../packages/client/src/url-state.js';

// Node-runnable parts of the Live browser runtime, imported from source for
// the coverage gate: the confirmation lifecycle, path reads, the Trusted Types
// policy, event names, title and download effects, and URL state writes. The
// browser suites (client-confirmation, client-url-state, client-csp) prove the
// same behaviour through the bundled runtime in real engines.

/** Minimal stand-in for a DOM element: identity plus `contains`. */
function node(children: object[] = []): Element {
  const element = {
    contains: (other: unknown) =>
      other === element || children.includes(other as object),
  };
  return element as unknown as Element;
}

function timers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout: (callback: () => void) => {
      pending.set(++id, callback);
      return id;
    },
    clearTimeout: (timer: number) => {
      pending.delete(timer);
    },
    fire: () => {
      for (const callback of [...pending.values()]) callback();
    },
    pending,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConfirmationController', () => {
  const base = (
    confirm: Parameters<typeof createConfirmationController>[0]['confirm'],
    extra = {},
  ) => {
    const clock = timers();
    let now = 0;
    const controller = createConfirmationController({
      confirm,
      now: () => now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      ...extra,
    });
    return { controller, clock, advance: (ms: number) => (now += ms) };
  };

  it('validates the handler and timeout', () => {
    expect(() =>
      createConfirmationController({
        confirm: 'yes' as unknown as () => boolean,
        now: () => 0,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      }),
    ).toThrow('Confirmation handler must be a function');
    for (const timeoutMs of [0, 300_001, 1.5])
      expect(() => base(() => true, { timeoutMs })).toThrow(
        'Confirmation timeout must be an integer',
      );
  });

  it('resolves the handler verdict with a frozen context and clears its timer', async () => {
    const seen: unknown[] = [];
    const { controller, clock } = base((context) => {
      seen.push(context);
      return true;
    });
    const element = node();
    await expect(
      controller.approve(element, 'delete', 'Sure?', () => true),
    ).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).toMatchObject({
      element,
      action: 'delete',
      message: 'Sure?',
    });
    expect(clock.pending.size).toBe(0);
    await expect(
      base(() => false).controller.approve(node(), 'a', 'm', () => true),
    ).resolves.toBe(false);
  });

  it('refuses stale, duplicate and disposed confirmations without asking', async () => {
    let asked = 0;
    const { controller } = base(() => {
      asked++;
      return new Promise<boolean>(() => undefined);
    });
    const element = node();
    await expect(
      controller.approve(element, 'a', 'm', () => false),
    ).resolves.toBe(false);
    await expect(
      controller.approve(element, 'a', 'm', () => {
        throw new Error('detached');
      }),
    ).resolves.toBe(false);
    const first = controller.approve(element, 'a', 'm', () => true);
    await expect(
      controller.approve(element, 'a', 'm', () => true),
    ).resolves.toBe(false);
    controller.dispose();
    await expect(first).resolves.toBe(false);
    await expect(
      controller.approve(node(), 'a', 'm', () => true),
    ).resolves.toBe(false);
    expect(asked).toBe(1);
  });

  it('rejects past 16 concurrent confirmations', async () => {
    const { controller } = base(() => new Promise<boolean>(() => undefined));
    for (let index = 0; index < 16; index++)
      void controller.approve(node(), 'a', 'm', () => true);
    await expect(
      controller.approve(node(), 'a', 'm', () => true),
    ).rejects.toThrow('Confirmation capacity reached');
    controller.dispose();
  });

  it('times out an unresolved dialog and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const { controller, clock } = base((context) => {
      signal = context.signal;
      return new Promise<boolean>(() => undefined);
    });
    const pending = controller.approve(node(), 'a', 'm', () => true);
    clock.fire();
    await expect(pending).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it('denies an approval that arrives after the timeout elapsed or once the element is gone', async () => {
    let release: (value: boolean) => void = () => undefined;
    const late = base(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    const pending = late.controller.approve(node(), 'a', 'm', () => true);
    late.advance(30_000);
    release(true);
    await expect(pending).resolves.toBe(false);

    let current = true;
    const gone = base(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );
    const removed = gone.controller.approve(node(), 'a', 'm', () => current);
    current = false;
    release(true);
    await expect(removed).resolves.toBe(false);
  });

  it.each([
    [
      'a non-boolean verdict',
      () => Promise.resolve('yes' as unknown as boolean),
    ],
    ['a rejected promise', () => Promise.reject(new Error('dialog crashed'))],
    [
      'a throwing handler',
      () => {
        throw new Error('sync');
      },
    ],
  ])('fails closed on %s', async (_, confirm) => {
    const { controller } = base(confirm);
    await expect(
      controller.approve(node(), 'a', 'm', () => true),
    ).rejects.toThrow('Live confirmation failed');
  });

  it('prunes detached confirmations and cancels those under a root', async () => {
    const { controller } = base(() => new Promise<boolean>(() => undefined));
    let attached = true;
    const detached = controller.approve(node(), 'a', 'm', () => attached);
    const child = node();
    const root = node([child]);
    const inside = controller.approve(child, 'a', 'm', () => true);
    const other = node();
    const outside = controller.approve(other, 'a', 'm', () => true);
    attached = false;
    controller.prune();
    await expect(detached).resolves.toBe(false);
    controller.cancel(root);
    await expect(inside).resolves.toBe(false);
    controller.cancel(other);
    await expect(outside).resolves.toBe(false);
    await tick();
  });
});

describe('readPath', () => {
  it('reads own data properties along plain-object paths only', () => {
    const values = {
      a: { b: { c: 1 } },
      list: [{ x: 1 }],
      get g() {
        return 1;
      },
    };
    expect(readPath(values, 'a.b.c')).toBe(1);
    expect(readPath(values, 'a.missing.c')).toBeUndefined();
    expect(readPath(values, 'list.0')).toBeUndefined();
    expect(readPath(values, 'g')).toBeUndefined();
    expect(readPath(values, 'toString')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('trustedHTML', () => {
  it('returns the plain string when the view has no Trusted Types', () => {
    expect(trustedHTML({}, '<p>x</p>')).toBe('<p>x</p>');
  });

  it('creates one nestvexa policy per view and routes HTML through it', () => {
    const names: string[] = [];
    const view = {
      trustedTypes: {
        createPolicy(
          name: string,
          rules: { createHTML(input: string): string },
        ) {
          names.push(name);
          return {
            createHTML: (input: string) => `trusted:${rules.createHTML(input)}`,
          };
        },
      },
    };
    expect(trustedHTML(view, '<b>')).toBe('trusted:<b>');
    expect(trustedHTML(view, '<i>')).toBe('trusted:<i>');
    expect(names).toEqual(['nestvexa']);
  });

  it('keeps the plain string when the page policy forbids the nestvexa name', () => {
    const view = {
      trustedTypes: {
        createPolicy() {
          throw new TypeError('policy not allowed');
        },
      },
    };
    expect(trustedHTML(view, '<b>')).toBe('<b>');
  });
});

describe('parseEventName', () => {
  it.each(['saved', 'cart:item.added', 'a-b'])('accepts %s', (name) => {
    expect(parseEventName(name)).toBe(name);
  });
  it.each(['', 'Saved', '1a', 'a b', 'a'.repeat(65), 3, null])(
    'rejects %j',
    (name) => {
      expect(() => parseEventName(name)).toThrow(LiveClientError);
    },
  );
});

describe('Live response title and download effects', () => {
  const response = (extra: Record<string, unknown>) => ({
    protocol: 'nestvexa-live/1',
    requestId: 'r1',
    component: { id: 'c1', name: 'counter', revision: 1 },
    snapshot: 'opaque',
    state: {},
    html: '<div></div>',
    ...extra,
  });
  const token = 'A'.repeat(43);

  it('accepts a bounded plain-text title and a same-origin download', () => {
    const parsed = parseLiveResponse(
      response({
        title: 'Orders · Shop',
        download: { url: `/_download/${token}`, filename: 'report.csv' },
      }),
    );
    expect(parsed.title).toBe('Orders · Shop');
    expect(parsed.download).toEqual({
      url: `/_download/${token}`,
      filename: 'report.csv',
    });
  });

  it.each(['', 'a'.repeat(201), 'line\nbreak', 'tab\u007f', 5])(
    'rejects title %j',
    (title) => {
      expect(() => parseLiveResponse(response({ title }))).toThrow(
        'Invalid Live title',
      );
    },
  );

  it.each([
    ['not an object', 'x'],
    ['an extra key', { url: `/_download/${token}`, filename: 'a', extra: 1 }],
    ['an empty filename', { url: `/_download/${token}`, filename: '' }],
    [
      'a long filename',
      { url: `/_download/${token}`, filename: 'a'.repeat(181) },
    ],
    ['a short token', { url: '/_download/abc', filename: 'a' }],
    [
      'a foreign origin',
      { url: `https://evil.test/_download/${token}`, filename: 'a' },
    ],
  ])('rejects a download with %s', (_, download) => {
    expect(() => parseLiveResponse(response({ download }))).toThrow(
      LiveClientError,
    );
  });
});

describe('applyUrlEffects', () => {
  function view(href: string) {
    const calls: [string, unknown, string][] = [];
    const state = { host: true };
    const window = {
      location: { href },
      history: {
        state,
        pushState: (data: unknown, _: string, url: string) => {
          calls.push(['push', data, url]);
          window.location.href = url;
        },
        replaceState: (data: unknown, _: string, url: string) => {
          calls.push(['replace', data, url]);
          window.location.href = url;
        },
      },
    };
    return { window: window as unknown as Window, calls, state };
  }

  it('replaces by default, preserves unrelated parameters and host history state', () => {
    const { window, calls, state } = view(
      'https://app.test/list?page=2&keep=1',
    );
    expect(
      applyUrlEffects(window, [
        { key: 'page', value: '3', history: 'replace' },
      ]),
    ).toBe(true);
    expect(calls).toEqual([
      ['replace', state, 'https://app.test/list?page=3&keep=1'],
    ]);
  });

  it('pushes when any changed effect asks for push and deletes null values', () => {
    const { window, calls } = view('https://app.test/list?q=a&q=b&sort=name');
    expect(
      applyUrlEffects(window, [
        { key: 'q', value: null, history: 'push' },
        { key: 'sort', value: 'name', history: 'replace' },
      ]),
    ).toBe(true);
    expect(calls).toEqual([
      ['push', { host: true }, 'https://app.test/list?sort=name'],
    ]);
  });

  it('writes no history entry when nothing changes', () => {
    const { window, calls } = view('https://app.test/list?page=1');
    expect(
      applyUrlEffects(window, [
        { key: 'page', value: '1', history: 'push' },
        { key: 'missing', value: null, history: 'push' },
      ]),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses a URL above the 8 KiB document limit', () => {
    const { window, calls } = view('https://app.test/');
    expect(() =>
      applyUrlEffects(window, [
        { key: 'big', value: 'x'.repeat(9000), history: 'push' },
      ]),
    ).toThrow('URL state exceeds the document URL limit');
    expect(calls).toEqual([]);
  });
});
