import { describe, expect, it, vi } from 'vitest';
import {
  adoptLiveAlpine,
  hostAlpine,
  startLiveAlpine,
} from '../packages/alpine/src/index.js';
import type {
  AlpineRuntime,
  ManagedLiveClient,
} from '../packages/alpine/src/index.js';

// Document ownership for the default Live/Alpine bootstraps
// (startLiveAlpine, adoptLiveAlpine, hostAlpine) against a minimal document
// and window double, imported from source for the coverage gate.
// tests/alpine-start.test.ts runs the same lifecycle with real Alpine in
// Chromium; tests/alpine.test.ts covers the `$live` magic itself.

class FakeView extends EventTarget {
  document: unknown;
}
function page() {
  const view = new FakeView();
  const body = { id: 'body' };
  const doc = { defaultView: view, body };
  view.document = doc;
  return { view, doc: doc as unknown as Document, body };
}
function runtime(overrides: Partial<AlpineRuntime> = {}) {
  const calls: string[] = [];
  const alpine: AlpineRuntime = {
    version: '3.17.5',
    magic: () => calls.push('magic'),
    reactive: (value) => value,
    start: () => calls.push('start'),
    destroyTree: (root) => calls.push(`destroy:${(root as { id: string }).id}`),
    ...overrides,
  };
  return { alpine, calls };
}
function client(overrides: Partial<ManagedLiveClient> = {}) {
  const calls: string[] = [];
  const live: ManagedLiveClient = {
    call: async () => undefined,
    get: () => undefined,
    set: () => undefined,
    mount: () => calls.push('mount'),
    dispose: () => calls.push('dispose'),
    ...overrides,
  };
  return { live, calls };
}
const pagehide = (persisted: boolean) =>
  Object.assign(new Event('pagehide'), { persisted });

describe('startLiveAlpine', () => {
  it('installs, configures, mounts and starts once per document', () => {
    const { doc, view, body } = page();
    const { alpine, calls } = runtime();
    const { live, calls: clientCalls } = client();
    const configure = vi.fn();
    const application = startLiveAlpine(alpine, live, {
      document: doc,
      configure,
    });
    expect(calls).toEqual(['magic', 'start']);
    expect(clientCalls).toEqual(['mount']);
    expect(configure).toHaveBeenCalledWith(alpine, live);
    expect(Object.isFrozen(application)).toBe(true);
    // The same Alpine coalesces; another runtime is refused.
    expect(startLiveAlpine(alpine, live, { document: doc })).toBe(application);
    expect(() =>
      startLiveAlpine(runtime().alpine, live, { document: doc }),
    ).toThrow('already belongs to another Alpine runtime');
    view.dispatchEvent(new Event('nestvexa:navigate'));
    expect(calls).toContain(`destroy:${body.id}`);
    // A BFCache-persisted pagehide keeps Live; an ordinary departure disposes it.
    view.dispatchEvent(pagehide(true));
    expect(clientCalls).toEqual(['mount']);
    view.dispatchEvent(pagehide(false));
    expect(clientCalls).toEqual(['mount', 'dispose']);
    application.dispose();
    expect(clientCalls).toEqual(['mount', 'dispose']);
    expect(() => startLiveAlpine(alpine, live, { document: doc })).toThrow(
      'Live/Alpine startup is disposed; reload the document',
    );
  });

  it('tolerates an Alpine without destroyTree on navigation', () => {
    const { doc, view } = page();
    const { alpine: full } = runtime();
    const alpine: AlpineRuntime = {
      version: full.version,
      magic: full.magic,
      reactive: full.reactive,
      start: full.start,
    };
    startLiveAlpine(alpine, client().live, { document: doc });
    expect(() =>
      view.dispatchEvent(new Event('nestvexa:navigate')),
    ).not.toThrow();
  });

  it('refuses a page whose host already owns Alpine', () => {
    const { doc, view } = page();
    Object.assign(view, { Alpine: {} });
    expect(() =>
      startLiveAlpine(runtime().alpine, client().live, { document: doc }),
    ).toThrow('The host already owns Alpine');
  });

  it.each([
    [
      'an Alpine without start()',
      () => runtime({ start: undefined as never }).alpine,
      () => client().live,
    ],
    [
      'a client without mount()',
      () => runtime().alpine,
      () => client({ mount: undefined as never }).live,
    ],
  ])('requires complete lifecycle APIs: %s', (_, alpine, live) => {
    expect(() =>
      startLiveAlpine(alpine(), live(), { document: page().doc }),
    ).toThrow('requires complete lifecycle APIs');
  });

  it('requires an attached browser document', () => {
    expect(() => startLiveAlpine(runtime().alpine, client().live)).toThrow(
      'requires an attached browser document',
    );
    const detached = { defaultView: new FakeView() } as unknown as Document;
    expect(() =>
      adoptLiveAlpine(runtime().alpine, client().live, { document: detached }),
    ).toThrow('requires an attached browser document');
  });

  it('rejects an incompatible bootstrap record on the document', () => {
    const { doc } = page();
    Object.defineProperty(doc, Symbol.for('nestvexa.alpine.application/1'), {
      value: { contract: 'other', status: 'active', application: {} },
    });
    expect(() =>
      startLiveAlpine(runtime().alpine, client().live, { document: doc }),
    ).toThrow('incompatible Live/Alpine bootstrap owner');
  });

  it.each([
    ['configuration', 'configure'],
    ['mounting', 'mount'],
    ['initializing Alpine', 'start'],
  ] as const)(
    'fails when the application is disposed during %s',
    (phase, step) => {
      const { doc } = page();
      let application: { dispose(): void } | undefined;
      const dispose = () => application?.dispose();
      const { alpine } = runtime(step === 'start' ? { start: dispose } : {});
      const { live, calls } = client(
        step === 'mount' ? { mount: dispose } : {},
      );
      // The configure hook receives no application; capture it through the record.
      const capture = () => {
        const record = Object.getOwnPropertyDescriptor(
          doc,
          Symbol.for('nestvexa.alpine.application/1'),
        )?.value as { application: { dispose(): void } } | undefined;
        application = record?.application;
        if (step === 'configure') dispose();
      };
      expect(() =>
        startLiveAlpine(alpine, live, { document: doc, configure: capture }),
      ).toThrow(
        `Live/Alpine startup was disposed ${phase === 'configuration' ? 'during configuration' : `while ${phase}`}`,
      );
      // Disposal already released Live once; failure does not dispose it again.
      expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
      expect(() => startLiveAlpine(alpine, live, { document: doc })).toThrow(
        'startup is failed',
      );
    },
  );

  it('disposes Live when startup throws and reports cleanup failures together', () => {
    const first = page();
    const { live, calls } = client();
    expect(() =>
      startLiveAlpine(
        runtime({
          start: () => {
            throw new Error('alpine boom');
          },
        }).alpine,
        live,
        { document: first.doc },
      ),
    ).toThrow('alpine boom');
    expect(calls).toEqual(['mount', 'dispose']);
    const second = page();
    let caught: unknown;
    try {
      startLiveAlpine(
        runtime({
          start: () => {
            throw new Error('alpine boom');
          },
        }).alpine,
        client({
          dispose: () => {
            throw new Error('cleanup boom');
          },
        }).live,
        { document: second.doc },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(['alpine boom', 'cleanup boom']);
  });
});

describe('adoptLiveAlpine', () => {
  it('mounts without starting and keeps the host in charge of Alpine', () => {
    const { doc } = page();
    const { alpine, calls } = runtime();
    const { live, calls: clientCalls } = client();
    const application = adoptLiveAlpine(alpine, live, { document: doc });
    expect(calls).toEqual(['magic']);
    expect(clientCalls).toEqual(['mount']);
    expect(adoptLiveAlpine(alpine, live, { document: doc })).toBe(application);
    expect(() => startLiveAlpine(alpine, live, { document: doc })).toThrow(
      'The host owns this Alpine lifecycle',
    );
  });

  it('validates the configure hook', () => {
    expect(() =>
      adoptLiveAlpine(runtime().alpine, client().live, {
        document: page().doc,
        configure: 'no' as never,
      }),
    ).toThrow('requires complete lifecycle APIs');
  });
});

describe('hostAlpine', () => {
  it('reads window.Alpine only as a plain data property', () => {
    const alpine = { version: '3.17.5' };
    expect(hostAlpine({ Alpine: alpine } as unknown as Window)).toBe(alpine);
    const accessor = {};
    Object.defineProperty(accessor, 'Alpine', { get: () => alpine });
    expect(hostAlpine(accessor as Window)).toBeUndefined();
    expect(hostAlpine({} as Window)).toBeUndefined();
    // No window in Node: the default parameter is undefined.
    expect(hostAlpine()).toBeUndefined();
  });
});
