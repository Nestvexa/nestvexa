import { describe, expect, it } from 'vitest';
import {
  createLiveClient,
  parseDirective,
  parseIdentifier,
  parseLiveResponse,
} from '../packages/client/dist/index.js';

describe('browser protocol boundary', () => {
  it('parses initialization as a registered action identifier', () => {
    expect(parseDirective('nv:init', 'load')).toEqual({
      kind: 'init',
      value: 'load',
    });
  });
  it.each(['', 'load()', 'a.b', 'constructor', '__proto__'])(
    'rejects invalid initialization action %s',
    (action) => {
      expect(() => parseDirective('nv:init', action)).toThrow();
    },
  );
  it.each([
    'nv:init.once',
    'nv:init.lazy',
    'nv:init.debounce.100ms',
    'nv:init.visible.idle',
  ])('rejects unsupported initialization modifiers %s', (name) => {
    expect(() => parseDirective(name, 'load')).toThrow();
  });
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
    expect(parseDirective('nv:ignore.self', '')).toEqual({
      kind: 'ignore',
      self: true,
      value: '',
    });
    expect(parseDirective('nv:model.live', 'name')).toEqual({
      kind: 'model',
      value: 'name',
    });
    expect(parseDirective('nv:poll', 'refresh')).toEqual({
      kind: 'poll',
      value: 'refresh',
      intervalMs: 2500,
    });
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
  it.each([
    ['nv:ignore.self', 'run()'],
    ['nv:ignore.self', ' '],
    ['nv:ignore.unknown', ''],
    ['nv:ignore.self.self', ''],
    ['nv:ignore.self.once', ''],
  ])('rejects unsupported ignore configuration %s=%s', (name, value) => {
    expect(() => parseDirective(name, value)).toThrow();
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
  it.each([
    'Delete this item?',
    '<script>alert(1)</script>',
    'تأكيد الحذف؟',
    'Line one\nLine two',
  ])('treats confirmation %s as literal text', (message) => {
    expect(parseDirective('nv:confirm', message)).toEqual({
      kind: 'confirm',
      message,
    });
  });
  it.each(['', '   ', 'x'.repeat(1025), 'a\0b', 'a\u007fb'])(
    'rejects malformed confirmation text',
    (message) => {
      expect(() => parseDirective('nv:confirm', message)).toThrow();
    },
  );
  it.each([
    'nv:confirm.once',
    'nv:confirm.html',
    'nv:confirm.prompt',
    'nv:confirm.unknown',
  ])('rejects executable or unsupported confirmation modifiers %s', (name) => {
    expect(() => parseDirective(name, 'Continue?')).toThrow();
  });
});
