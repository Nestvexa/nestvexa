import { describe, expect, it } from 'vitest';
import {
  NestvexaConfigError,
  mergeNestvexaOptions,
  nestvexaOptionsFromEnvironment,
  normalizeOptions,
} from '../packages/core/src/index.js';
import {
  LiveProtocolError,
  parseLiveCapabilities,
} from '../packages/live/src/protocol.js';
import {
  MemoryLiveStore,
  freezeChildReferences,
  isLiveStateStore,
} from '../packages/live/src/store.js';

/**
 * Source-level checks for the high-risk coverage gate. The behavioural suites
 * (core-config, live-protocol-contract, live-store-contract) exercise the same
 * functions through the built packages, which the source coverage gate cannot see.
 */
function issuesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NestvexaConfigError);
    return (error as NestvexaConfigError).issues.map((issue) => issue.path);
  }
  throw new Error('expected a configuration error');
}

describe('core configuration layers (source)', () => {
  it('merges layers with later values winning and skips undefined layers', () => {
    const merged = mergeNestvexaOptions(
      { views: { engine: 'hbs', root: 'a' }, live: { enabled: false } },
      undefined,
      { views: { root: 'b', layout: false }, live: { enabled: true } },
      { security: { csrf: false } },
    );
    expect(merged).toEqual({
      views: { engine: 'hbs', root: 'b', layout: false },
      live: { enabled: true },
      security: { csrf: false },
    });
    expect(normalizeOptions(merged).views.root).toBe('b');
  });

  it('reports per-layer paths and rejects an invalid combined result', () => {
    expect(
      issuesOf(() =>
        mergeNestvexaOptions({ views: { root: 'x' } }, {
          views: { cache: 'yes' },
        } as never),
      ),
    ).toContain('views.cache');
    expect(
      issuesOf(() =>
        mergeNestvexaOptions({ live: { client: 'react' } } as never),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects symbol keys and non-plain objects', () => {
    const symbolic = { [Symbol('x')]: 1 } as never;
    expect(issuesOf(() => normalizeOptions(symbolic)).length).toBe(1);
    expect(issuesOf(() => normalizeOptions(new Date() as never))).toEqual([
      'options',
    ]);
    expect(
      issuesOf(() => normalizeOptions({ views: { engine: 'Bad Engine' } })),
    ).toContain('views.engine');
  });

  it('maps documented variables, booleans and the layout switch', () => {
    expect(
      nestvexaOptionsFromEnvironment({
        NESTVEXA_VIEWS_ENGINE: 'ejs',
        NESTVEXA_VIEWS_ROOT: 'views',
        NESTVEXA_VIEWS_CACHE: '1',
        NESTVEXA_VIEWS_LAYOUT: 'FALSE',
        NESTVEXA_LIVE_ENABLED: 'true',
        NESTVEXA_LIVE_CLIENT: 'manual',
        NESTVEXA_SECURITY_CSRF: '0',
        NESTVEXA_SECURITY_REQUIRE_AUTHORIZED_ACTIONS: ' False ',
        NESTVEXA_OTHER: 'ignored',
        PATH: 'ignored',
      }),
    ).toEqual({
      views: { engine: 'ejs', root: 'views', cache: true, layout: false },
      live: { enabled: true, client: 'manual' },
      security: { csrf: false, requireAuthorizedActions: false },
    });
    expect(
      nestvexaOptionsFromEnvironment({ NESTVEXA_VIEWS_LAYOUT: 'main' }),
    ).toEqual({ views: { layout: 'main' } });
    expect(
      nestvexaOptionsFromEnvironment({ NESTVEXA_VIEWS_ROOT: undefined }),
    ).toEqual({});
  });

  it('rejects typos, bad booleans, non-strings and non-objects without echoing values', () => {
    const secret = 'super-secret-value';
    let message = '';
    try {
      nestvexaOptionsFromEnvironment({
        NESTVEXA_VIEWS_ROOTS: secret,
        NESTVEXA_LIVE_ENABLED: secret,
      });
    } catch (error) {
      message = (error as Error).message;
      expect((error as NestvexaConfigError).issues.map((i) => i.path)).toEqual([
        'NESTVEXA_VIEWS_ROOTS',
        'NESTVEXA_LIVE_ENABLED',
      ]);
    }
    expect(message).not.toContain(secret);
    expect(
      issuesOf(() =>
        nestvexaOptionsFromEnvironment({
          NESTVEXA_VIEWS_ROOT: 3,
        } as never),
      ),
    ).toEqual(['NESTVEXA_VIEWS_ROOT']);
    expect(
      issuesOf(() => nestvexaOptionsFromEnvironment(null as never)),
    ).toEqual(['environment']);
    expect(issuesOf(() => nestvexaOptionsFromEnvironment([] as never))).toEqual(
      ['environment'],
    );
    expect(
      issuesOf(() =>
        nestvexaOptionsFromEnvironment({ NESTVEXA_LIVE_CLIENT: 'react' }),
      ),
    ).toEqual(['live.client']);
  });
});

describe('Live capability header (source)', () => {
  it('accepts known tokens and ignores unknown well-formed tokens', () => {
    expect([...parseLiveCapabilities(undefined)]).toEqual([]);
    expect([...parseLiveCapabilities('')]).toEqual([]);
    expect([...parseLiveCapabilities('renderless-v1, future-v9')]).toEqual([
      'renderless-v1',
    ]);
  });

  it.each([
    ['non-string', 42],
    ['oversized', 'a'.repeat(513)],
    ['too many tokens', Array.from({ length: 17 }, (_, i) => `t${i}`).join()],
    ['malformed token', 'renderless-v1,<script>'],
  ])('rejects a %s header with INVALID_CAPABILITIES', (_label, header) => {
    let caught: unknown;
    try {
      parseLiveCapabilities(header);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveProtocolError);
    expect(caught).toMatchObject({ code: 'INVALID_CAPABILITIES', status: 400 });
  });
});

describe('Live state store helpers (source)', () => {
  it('recognises stores structurally', () => {
    expect(isLiveStateStore(new MemoryLiveStore())).toBe(true);
    expect(isLiveStateStore(null)).toBe(false);
    expect(isLiveStateStore('store')).toBe(false);
    expect(isLiveStateStore({ create() {}, peek() {} })).toBe(false);
  });

  it('detaches and freezes child references', () => {
    expect(freezeChildReferences(undefined)).toBeUndefined();
    const source = {
      list: { alias: 'list', name: 'todo-list', id: 'i', token: 't', x: 1 },
    };
    const frozen = freezeChildReferences(source);
    expect(frozen).toEqual({
      list: { alias: 'list', name: 'todo-list', id: 'i', token: 't' },
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen?.['list'])).toBe(true);
    expect(Object.getPrototypeOf(frozen)).toBeNull();
  });

  it('clears entries on close and reports size', () => {
    const store = new MemoryLiveStore();
    const created = store.create('counter', 'session-a', { count: 1 });
    expect(store.size).toBe(1);
    expect(store.delete(created.snapshot)).toBe(true);
    expect(store.delete(created.snapshot)).toBe(false);
    store.create('counter', 'session-a', { count: 2 });
    store.close();
    expect(store.size).toBe(0);
  });

  it('rejects invalid capacity and TTL options', () => {
    for (const options of [
      { ttlMs: 0 },
      { ttlMs: 86_400_001 },
      { maxEntries: 0 },
      { maxEntries: 100_001 },
      { ttlMs: 1.5 },
    ])
      expect(() => new MemoryLiveStore(options)).toThrow(LiveProtocolError);
  });
});
