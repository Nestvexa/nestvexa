import { describe, expect, it } from 'vitest';
import {
  evaluateBinding,
  parseBindingDirective,
} from '../packages/client/dist/bindings.js';

describe('safe Live data bindings', () => {
  it('parses each implemented binding with identifiers only', () => {
    expect(parseBindingDirective('nv:text', 'name')).toEqual({
      kind: 'text',
      field: 'name',
    });
    expect(parseBindingDirective('nv:show', 'visible')).toEqual({
      kind: 'show',
      field: 'visible',
    });
    expect(parseBindingDirective('nv:bind', 'aria-label:name')).toEqual({
      kind: 'bind',
      attribute: 'aria-label',
      field: 'name',
    });
    expect(parseBindingDirective('nv:dirty', '')).toEqual({ kind: 'dirty' });
    expect(parseBindingDirective('nv:dirty', 'name')).toEqual({
      kind: 'dirty',
      field: 'name',
    });
    expect(parseBindingDirective('nv:cloak', '')).toEqual({ kind: 'cloak' });
    expect(parseBindingDirective('nv:ref', 'field')).toEqual({
      kind: 'ref',
      name: 'field',
    });
  });
  it.each([
    ['nv:text', 'user.__proto__'],
    ['nv:show', '!visible'],
    ['nv:ref', '__proto__'],
    ['nv:bind', 'style:name'],
    ['nv:bind', 'onclick:name'],
    ['nv:bind', 'srcdoc:html'],
    ['nv:bind', 'title:name:other'],
    ['nv:bind', 'title:'],
    ['nv:bind', 'title:name()'],
    ['nv:cloak', 'true'],
    ['nv:show.transition', 'visible'],
    ['nv:bind.href', 'url'],
  ])('rejects configuration %s=%s', (name, value) => {
    expect(() => parseBindingDirective(name, value)).toThrow();
  });
  it('converts finite primitive text without ever creating markup', () => {
    const binding = parseBindingDirective('nv:text', 'name');
    expect(
      evaluateBinding(
        binding,
        '<img src=x onerror=alert(1)>',
        'https://example.com',
      ),
    ).toBe('<img src=x onerror=alert(1)>');
    expect(evaluateBinding(binding, null, 'https://example.com')).toBe('');
    expect(evaluateBinding(binding, 42, 'https://example.com')).toBe('42');
    expect(() => evaluateBinding(binding, {}, 'https://example.com')).toThrow();
    expect(() =>
      evaluateBinding(binding, Infinity, 'https://example.com'),
    ).toThrow();
  });
  it('requires exact booleans for visibility and boolean attributes', () => {
    const show = parseBindingDirective('nv:show', 'visible');
    const disabled = parseBindingDirective('nv:bind', 'disabled:pending');
    expect(evaluateBinding(show, false, 'https://example.com')).toBe(false);
    expect(evaluateBinding(disabled, true, 'https://example.com')).toBe(true);
    for (const value of ['false', 0, null, undefined, {}])
      expect(() =>
        evaluateBinding(show, value, 'https://example.com'),
      ).toThrow();
  });
  it.each([
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>',
    'vbscript:x',
    'file:///tmp/file',
    'https://user:password@example.com',
    'https://example.com/a b',
    '\u0000/path',
  ])('rejects dangerous bound URL %s', (value) => {
    const binding = parseBindingDirective('nv:bind', 'href:destination');
    expect(() =>
      evaluateBinding(binding, value, 'https://example.com/page'),
    ).toThrow();
  });
  it('allows explicit HTTP(S), relative URLs, fragments, and null removal', () => {
    const binding = parseBindingDirective('nv:bind', 'href:destination');
    for (const value of [
      'https://docs.example.com',
      'http://localhost:3100',
      '/catalog?q=x',
      '../about',
      '#section',
    ])
      expect(evaluateBinding(binding, value, 'https://example.com/page')).toBe(
        value,
      );
    expect(
      evaluateBinding(binding, null, 'https://example.com/page'),
    ).toBeNull();
  });
});
