import type { JsonValue } from './protocol.js';

/** Bounds for `@State({ writable: [...] })` nested path allowlists. */
export const WRITABLE_PATH_LIMITS = Object.freeze({
  maxPaths: 64,
  maxDepth: 8,
});
const segment = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Validate a nested writable allowlist at decoration time. Paths are relative
 * to the field (`'city'`, `'geo.lat'`), use identifier segments only (no array
 * indices, wildcards or expressions), are unique, and none is a prefix of
 * another, so every allowed leaf has exactly one owner.
 */
export function parseWritablePaths(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WRITABLE_PATH_LIMITS.maxPaths
  )
    throw new Error(
      `State writable paths must be a non-empty array of at most ${WRITABLE_PATH_LIMITS.maxPaths} entries`,
    );
  const paths: string[] = [];
  for (const path of value as unknown[]) {
    if (typeof path !== 'string')
      throw new Error('State writable paths must be strings');
    const segments = path.split('.');
    if (
      segments.length > WRITABLE_PATH_LIMITS.maxDepth ||
      segments.some((part) => !segment.test(part) || forbidden.has(part))
    )
      throw new Error(`Invalid state writable path ${JSON.stringify(path)}`);
    paths.push(path);
  }
  for (const path of paths)
    if (
      paths.indexOf(path) !== paths.lastIndexOf(path) ||
      paths.some((other) => other.startsWith(`${path}.`))
    )
      throw new Error(
        `State writable paths must be unique and not nest: ${JSON.stringify(path)}`,
      );
  return Object.freeze(paths);
}

function kind(value: JsonValue): string {
  return value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value;
}
function plainObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return kind(value) === 'object';
}
function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (kind(left) !== kind(right)) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => {
        const other = right[index];
        return other !== undefined && equalJson(item, other);
      })
    );
  if (plainObject(left) && plainObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        const a = left[key];
        const b = right[key];
        return (
          Object.hasOwn(right, key) &&
          a !== undefined &&
          b !== undefined &&
          equalJson(a, b)
        );
      })
    );
  }
  return Object.is(left, right);
}

/**
 * Compare a client proposal with the stored value of a path-restricted field.
 * Returns `'locked'` when anything outside the allowlist changed (including
 * added or removed keys), `'type'` when an allowed leaf changed its JSON kind,
 * and `'ok'` otherwise. Values are already validated, frozen JSON.
 */
export function checkWritablePaths(
  previous: JsonValue,
  next: JsonValue,
  paths: readonly string[],
): 'ok' | 'locked' | 'type' {
  const allowed = new Set(paths);
  const visit = (
    before: JsonValue,
    after: JsonValue,
    prefix: string,
  ): 'ok' | 'locked' | 'type' => {
    if (prefix && allowed.has(prefix))
      return kind(before) === kind(after) ? 'ok' : 'type';
    if (!plainObject(before) || !plainObject(after))
      return equalJson(before, after) ? 'ok' : 'locked';
    const keys = Object.keys(before);
    if (
      keys.length !== Object.keys(after).length ||
      keys.some((key) => !Object.hasOwn(after, key))
    )
      return 'locked';
    for (const key of keys) {
      const a = before[key];
      const b = after[key];
      if (a === undefined || b === undefined) return 'locked';
      const result = visit(a, b, prefix ? `${prefix}.${key}` : key);
      if (result !== 'ok') return result;
    }
    return 'ok';
  };
  return visit(previous, next, '');
}
