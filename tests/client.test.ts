import { describe, expect, it } from 'vitest';
import {
  createLiveClient,
  parseDirective,
  parseIdentifier,
  parseLiveResponse,
} from '../packages/client/dist/index.js';

describe('browser protocol boundary', () => {
  it('imports without accessing a browser and fails explicitly when mounted without one', () => {
    expect(() => createLiveClient()).toThrow('browser document');
  });
  it.each([
    'increment()',
    'constructor',
    '__proto__',
    'alert(1)',
    'foo.bar',
    'x y',
    '',
  ])('rejects executable or unsafe action %s', (value) => {
    expect(() => parseIdentifier(value)).toThrow();
  });
  it('accepts only implemented directives and rejects unsupported modifiers', () => {
    expect(parseDirective('nv:click', 'increment')).toEqual({
      kind: 'click',
      value: 'increment',
    });
    expect(parseDirective('nv:ignore', '')).toEqual({
      kind: 'ignore',
      value: '',
    });
    expect(parseDirective('nv:model.live', 'name')).toEqual({
      kind: 'model',
      value: 'name',
    });
    expect(() => parseDirective('nv:poll', 'refresh')).toThrow();
    expect(() => parseDirective('nv:ignore', 'expression')).toThrow();
    expect(parseDirective('nv:replace', '')).toEqual({
      kind: 'replace',
      self: false,
    });
    expect(parseDirective('nv:replace.self', '')).toEqual({
      kind: 'replace',
      self: true,
    });
    expect(parseDirective('nv:target', 'increment, $sync')).toEqual({
      kind: 'target',
      actions: ['increment', '$sync'],
    });
    expect(() => parseDirective('nv:replace', 'code()')).toThrow();
    expect(() => parseDirective('nv:replace.unknown', '')).toThrow();
  });
  it('validates revision, envelope and state keys before accepting responses', () => {
    const result = {
      protocol: 'nestvexa-live/1',
      requestId: 'id',
      component: { id: 'component', name: 'counter', revision: 1 },
      snapshot: 'opaque',
      state: { count: 1 },
      html: '<output>1</output>',
    };
    expect(parseLiveResponse(result).component.revision).toBe(1);
    expect(() =>
      parseLiveResponse({
        ...result,
        component: { ...result.component, revision: -1 },
      }),
    ).toThrow();
    expect(() => parseLiveResponse({ ...result, protocol: 'other' })).toThrow();
    expect(() =>
      parseLiveResponse({ ...result, state: JSON.parse('{"__proto__":{}}') }),
    ).toThrow();
  });
});
