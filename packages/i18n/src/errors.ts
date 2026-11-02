export type I18nErrorCode =
  'CONFIG' | 'CATALOG' | 'LOCALE' | 'MESSAGE' | 'FORMAT' | 'MISSING';

/** Every failure raised by this package; messages never echo raw request data. */
export class I18nError extends Error {
  constructor(
    readonly code: I18nErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'I18nError';
  }
}

export const forbiddenKeys: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** Reads an own data property without invoking accessors or walking prototypes. */
export function own(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function isPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** HTML text/attribute escaping for interpolated values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return '&#96;';
    }
  });
}

/** Bounded insertion-ordered cache; evicts the oldest entry. */
export class BoundedCache<V> {
  readonly #map = new Map<string, V>();
  constructor(readonly limit: number) {}
  get(key: string): V | undefined {
    return this.#map.get(key);
  }
  set(key: string, value: V): V {
    if (!this.#map.has(key) && this.#map.size >= this.limit) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
    this.#map.set(key, value);
    return value;
  }
}
