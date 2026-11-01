import { describe, expect, it } from 'vitest';
import { parseLiveResponse } from '../packages/client/dist/index.js';

const envelope = {
  protocol: 'nestvexa-live/1',
  requestId: 'request-1',
  component: { id: 'component', name: 'counter', revision: 1 },
  snapshot: 'opaque-next-snapshot',
  state: { count: 1 },
  html: '<output>1</output>',
};

describe('renderless response protocol boundary', () => {
  it('preserves the ordinary response shape without adding a renderless flag', () => {
    expect(parseLiveResponse(envelope)).toEqual(envelope);
    expect(parseLiveResponse({ ...envelope, html: '' })).not.toHaveProperty(
      'renderless',
    );
  });

  it('accepts an explicit state acknowledgement with required empty HTML', () => {
    const acknowledgement = { ...envelope, html: '', renderless: true };
    expect(parseLiveResponse(acknowledgement)).toEqual(acknowledgement);
  });

  it.each([false, null, 0, 1, '', 'true', [], {}])(
    'rejects the present non-true renderless flag %j',
    (renderless) => {
      expect(() =>
        parseLiveResponse({ ...envelope, html: '', renderless }),
      ).toThrowError(expect.objectContaining({ code: 'RESPONSE' }));
    },
  );

  it('rejects an explicitly undefined flag rather than treating it as absent', () => {
    expect(() =>
      parseLiveResponse({ ...envelope, html: '', renderless: undefined }),
    ).toThrowError(expect.objectContaining({ code: 'RESPONSE' }));
  });

  it.each([' ', '<output>1</output>', '<script>attack()</script>'])(
    'rejects mixed HTML and renderless acknowledgement %j',
    (html) => {
      expect(() =>
        parseLiveResponse({ ...envelope, html, renderless: true }),
      ).toThrowError(expect.objectContaining({ code: 'RESPONSE' }));
    },
  );

  it.each([undefined, null, false, 0, {}])(
    'still requires a string HTML field for renderless responses (%j)',
    (html) => {
      expect(() =>
        parseLiveResponse({ ...envelope, html, renderless: true }),
      ).toThrowError(expect.objectContaining({ code: 'RESPONSE' }));
    },
  );

  it('rejects renderless responses with no HTML field', () => {
    const withoutHtml: Record<string, unknown> = { ...envelope };
    delete withoutHtml['html'];
    expect(() =>
      parseLiveResponse({ ...withoutHtml, renderless: true }),
    ).toThrowError(expect.objectContaining({ code: 'RESPONSE' }));
  });

  it.each([
    { component: { ...envelope.component, revision: -1 } },
    { snapshot: '' },
    { state: [] },
    { state: JSON.parse('{"__proto__":{}}') as unknown },
  ])('retains ordinary metadata and state validation: %j', (invalid) => {
    expect(() =>
      parseLiveResponse({
        ...envelope,
        ...invalid,
        html: '',
        renderless: true,
      }),
    ).toThrow();
  });
});
