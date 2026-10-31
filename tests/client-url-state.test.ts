import { describe, expect, it } from 'vitest';
import { parseUrlEffects } from '../packages/client/src/url-state.js';
import { parseLiveResponse } from '../packages/client/src/protocol.js';

describe('URL state effects trust boundary', () => {
  it('accepts bounded unique query keys, literal text, omission and explicit history behavior', () => {
    const effects = parseUrlEffects([
      { key: 'q', value: '</script> & مرحبا', history: 'replace' },
      { key: 'page', value: null, history: 'push' },
    ]);
    expect(effects).toEqual([
      { key: 'q', value: '</script> & مرحبا', history: 'replace' },
      { key: 'page', value: null, history: 'push' },
    ]);
    expect(Object.isFrozen(effects[0])).toBe(true);
  });
  it.each([
    null,
    {},
    'q=x',
    [null],
    [{ key: '__proto__', value: 'x', history: 'replace' }],
    [{ key: 'constructor', value: 'x', history: 'replace' }],
    [{ key: 'prototype', value: 'x', history: 'replace' }],
    [{ key: 'q.x', value: 'x', history: 'replace' }],
    [{ key: 'q', value: 1, history: 'replace' }],
    [{ key: 'q', value: 'x', history: 'go' }],
    [{ key: 'q', value: 'x', history: 'replace', url: 'https://evil.invalid' }],
    [
      { key: 'q', value: 'x', history: 'replace' },
      { key: 'q', value: null, history: 'push' },
    ],
    Array.from({ length: 65 }, (_, index) => ({
      key: `q${index}`,
      value: '',
      history: 'replace',
    })),
    [{ key: 'q', value: 'x'.repeat(8192), history: 'replace' }],
  ])(
    'rejects malformed URL effects before changing a document (%j)',
    (input) => {
      expect(() => parseUrlEffects(input)).toThrow('URL state');
    },
  );
  it('validates URL effects while parsing the response rather than after DOM mutation', () => {
    expect(() =>
      parseLiveResponse({
        protocol: 'nestvexa-live/1',
        requestId: 'fixture',
        component: { id: 'opaque', name: 'counter', revision: 1 },
        snapshot: 'opaque',
        state: {},
        html: '<p>valid</p>',
        url: [
          { key: 'q', value: 'x', history: 'replace', location: '/unsafe' },
        ],
      }),
    ).toThrow('URL state');
  });
});
