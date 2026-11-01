import { describe, expect, it, vi } from 'vitest';
import { parseLiveResponse } from '../packages/client/dist/index.js';
import { installLiveAlpine } from '../packages/alpine/src/index.js';
import type {
  AlpineHost,
  AlpineMagicUtilities,
  LiveMagic,
} from '../packages/alpine/src/index.js';

const envelope = {
  protocol: 'nestvexa-live/1',
  requestId: 'request-1',
  component: { id: 'component', name: 'board', revision: 1 },
  snapshot: 'opaque-next-snapshot',
  state: { count: 1 },
  html: '<output>1</output>',
};

describe('Live event and redirect response boundary', () => {
  it('accepts bounded events with optional exclusive targeting', () => {
    const events = [
      { name: 'member.left', payload: { id: 'ada' } },
      { name: 'note:saved', payload: null, to: 'log' },
      { name: 'local', payload: [1, 'two'], self: true },
    ];
    expect(parseLiveResponse({ ...envelope, events }).events).toEqual(events);
  });

  it.each([
    ['non-array', { name: 'x' }],
    ['too many', Array.from({ length: 17 }, () => ({ name: 'x', payload: 1 }))],
    ['unsafe name', [{ name: 'Bad Name', payload: 1 }]],
    ['missing payload', [{ name: 'x' }]],
    ['unknown field', [{ name: 'x', payload: 1, handler: 'alert' }]],
    ['invalid target', [{ name: 'x', payload: 1, to: 'Not A Name' }]],
    ['false self', [{ name: 'x', payload: 1, self: false }]],
    ['self and to', [{ name: 'x', payload: 1, self: true, to: 'log' }]],
    ['oversized payload', [{ name: 'x', payload: 'y'.repeat(16_400) }]],
  ])('rejects %s events', (_label, events) => {
    expect(() => parseLiveResponse({ ...envelope, events })).toThrow(
      /Invalid Live event/,
    );
  });

  it('accepts application-relative redirects', () => {
    expect(
      parseLiveResponse({ ...envelope, redirect: '/items/2?tab=a#top' })
        .redirect,
    ).toBe('/items/2?tab=a#top');
  });

  it.each([
    'https://evil.example/',
    '//evil.example/',
    'javascript:alert(1)',
    '/\\evil.example',
    '/line\nbreak',
    '',
    7,
    '/' + 'a'.repeat(2048),
  ])('rejects unsafe redirect %j', (redirect) => {
    expect(() => parseLiveResponse({ ...envelope, redirect })).toThrow(
      /Unsafe Live redirect/,
    );
  });
});

describe('Alpine $live.dispatch', () => {
  function install(dispatch?: (name: string, payload?: unknown) => void) {
    let callback:
      | ((element: HTMLElement, utilities: AlpineMagicUtilities) => unknown)
      | undefined;
    const alpine: AlpineHost = {
      version: '3.17.5',
      magic: (_name, value) => {
        callback = value;
      },
      reactive: (value) => value,
    };
    const client = {
      call: vi.fn(async () => undefined),
      get: vi.fn(),
      set: vi.fn(),
      ...(dispatch ? { dispatch } : {}),
    };
    installLiveAlpine(alpine, client);
    const component = Object.assign(new EventTarget(), {
      isConnected: true,
      parentElement: null,
      hasAttribute: (name: string) => name === 'data-nv-component',
      closest: (): unknown => component,
    });
    const ignored = Object.assign(new EventTarget(), {
      isConnected: true,
      parentElement: component,
      hasAttribute: (name: string) => name === 'nv:ignore',
      closest: (): unknown => component,
    });
    const element = Object.assign(new EventTarget(), {
      isConnected: true,
      parentElement: ignored,
      hasAttribute: () => false,
      closest: (): unknown => component,
    });
    if (!callback) throw new Error('Plugin not installed');
    return callback(element as unknown as HTMLElement, {
      cleanup: () => undefined,
    }) as LiveMagic;
  }

  it('delegates to the client bridge', () => {
    const dispatch = vi.fn();
    install(dispatch).dispatch('member.left', { id: 'ada' });
    expect(dispatch).toHaveBeenCalledWith('member.left', { id: 'ada' });
  });

  it('fails clearly when the bridge has no event support', () => {
    expect(() => install().dispatch('member.left')).toThrow(
      'does not support events',
    );
  });
});
