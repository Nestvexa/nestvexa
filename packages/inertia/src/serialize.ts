import { InertiaSerializationError } from './errors.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SerializeOptions {
  /**
   * Encode `bigint` values with the upstream `{"$bigint": "<digits>"}` marker
   * (client revives them when the page carries `preserveBigIntegers: true`).
   * When false, a `bigint` is rejected instead of being silently truncated.
   */
  readonly preserveBigIntegers: boolean;
  /** Maximum nesting depth; deeper structures are rejected. */
  readonly maxDepth: number;
}

/** Marker documented at https://inertiajs.com/docs/v3/advanced/big-integers */
export const BIGINT_MARKER = '$bigint';

const rejectedTypes: readonly [new (...args: never[]) => object, string][] = [
  [Map, 'Map values are not JSON'],
  [Set, 'Set values are not JSON'],
  [WeakMap, 'WeakMap values are not JSON'],
  [WeakSet, 'WeakSet values are not JSON'],
  [Promise, 'unresolved Promise; return the awaited value or a lazy prop'],
  [RegExp, 'RegExp values are not JSON'],
  [Error, 'Error objects are not page data'],
];

function join(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`;
}

/**
 * Converts arbitrary resolved prop data into strict JSON data with explicit,
 * documented rules: Dates (and any `toJSON`) use their JSON form, `undefined`
 * object members are omitted and array holes become `null` (JSON semantics),
 * while functions, symbols, non-finite numbers, cycles, Maps/Sets, Promises and
 * excessive depth fail loudly instead of degrading silently.
 */
export function toJsonValue(
  value: unknown,
  options: SerializeOptions,
): { readonly value: JsonValue; readonly bigint: boolean } {
  let bigint = false;
  const ancestors: object[] = [];
  const visit = (
    input: unknown,
    path: string,
    depth: number,
  ): JsonValue | undefined => {
    if (depth > options.maxDepth)
      throw new InertiaSerializationError(path, 'maximum depth exceeded');
    switch (typeof input) {
      case 'string':
      case 'boolean':
        return input;
      case 'number':
        if (!Number.isFinite(input))
          throw new InertiaSerializationError(path, 'non-finite number');
        return input;
      case 'bigint':
        if (!options.preserveBigIntegers)
          throw new InertiaSerializationError(
            path,
            'bigint requires preserveBigIntegers',
          );
        bigint = true;
        return { [BIGINT_MARKER]: input.toString() };
      case 'undefined':
        return undefined;
      case 'function':
        throw new InertiaSerializationError(path, 'functions are not JSON');
      case 'symbol':
        throw new InertiaSerializationError(path, 'symbols are not JSON');
      default:
        break;
    }
    if (input === null) return null;
    const object = input as object;
    if (object instanceof Date) {
      if (Number.isNaN(object.getTime()))
        throw new InertiaSerializationError(path, 'invalid Date');
      return object.toISOString();
    }
    for (const [type, reason] of rejectedTypes)
      if (object instanceof type)
        throw new InertiaSerializationError(path, reason);
    if (ancestors.includes(object))
      throw new InertiaSerializationError(path, 'circular reference');
    const toJSON: unknown = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      ancestors.push(object);
      try {
        const replaced: unknown = toJSON.call(object, path);
        if (replaced === object)
          throw new InertiaSerializationError(path, 'toJSON returned itself');
        return visit(replaced, path, depth + 1);
      } finally {
        ancestors.pop();
      }
    }
    ancestors.push(object);
    try {
      if (Array.isArray(object)) {
        const list: JsonValue[] = [];
        for (let index = 0; index < object.length; index++) {
          const item = visit(
            object[index] as unknown,
            join(path, index),
            depth + 1,
          );
          list.push(item === undefined ? null : item);
        }
        return list;
      }
      const record: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(object)) {
        if (key === '__proto__')
          throw new InertiaSerializationError(join(path, key), 'forbidden key');
        const item = visit(
          (object as Record<string, unknown>)[key],
          join(path, key),
          depth + 1,
        );
        if (item !== undefined) record[key] = item;
      }
      return record;
    } finally {
      ancestors.pop();
    }
  };
  const result = visit(value, '', 0);
  return { value: result === undefined ? null : result, bigint };
}

/**
 * Escapes JSON for embedding in an HTML `<script type="application/json">`
 * body. The v3 protocol requires `/` to be emitted as `\/` so `</script>` in
 * data cannot close the element; `<`, `>` and `&` are additionally hex-escaped
 * (as the Laravel adapter's `JSON_HEX_TAG` does) which also neutralizes
 * `<!--`, and U+2028/U+2029 are escaped for legacy script parsers. All of these
 * occur only inside JSON strings, where the escapes are lossless. HTML entities
 * are never used: the browser does not decode them inside script text.
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/[/<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case '/':
        return '\\/';
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

const htmlEscapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character] ?? '');
}
