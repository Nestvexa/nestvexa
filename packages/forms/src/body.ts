import {
  FormInputError,
  forbiddenKeys,
  formatPath,
  safeKey,
} from './errors.js';
import type { PathSegment } from './errors.js';
import {
  hardenInput,
  isFormObject,
  isPlainObject,
  resolveLimits,
} from './harden.js';
import type { FormValue, InputLimits } from './harden.js';

export interface FormBodyOptions {
  readonly limits?: InputLimits;
  /**
   * Top-level fields that are multi-value controls (checkbox groups, multiple
   * selects). A lone string becomes a one-item array and a missing field becomes
   * `[]`. Every other field keeps exactly the shape that was submitted.
   */
  readonly arrays?: readonly string[];
  /** Top-level keys removed before validation (always includes `_csrf` and `_submission`). */
  readonly omit?: readonly string[];
}

const bracketPath = /^([A-Za-z0-9_-]{1,128})((?:\[[A-Za-z0-9_-]{0,128}\])*)$/;

function segmentsOf(key: string): { segments: PathSegment[]; push: boolean } {
  const dotted = key.includes('.') && !key.includes('[');
  if (dotted) {
    const parts = key.split('.');
    return { segments: parts.map(segment), push: false };
  }
  const match = bracketPath.exec(key);
  if (!match) {
    const name = key.split(/[[.]/, 1)[0] ?? '';
    throw new FormInputError(
      forbiddenKeys.has(name) || /__proto__|constructor|prototype/.test(key)
        ? 'FORBIDDEN_KEY'
        : 'INVALID_KEY',
      '',
    );
  }
  const head = match[1] ?? '';
  const rest = [...(match[2] ?? '').matchAll(/\[([^\]]*)\]/g)].map(
    (item) => item[1] ?? '',
  );
  const push = rest.at(-1) === '';
  if (push) rest.pop();
  if (rest.includes('')) throw new FormInputError('INVALID_KEY', head);
  return { segments: [head, ...rest].map(segment), push };
}
function segment(part: string): PathSegment {
  if (forbiddenKeys.has(part)) throw new FormInputError('FORBIDDEN_KEY', '');
  if (!safeKey(part)) throw new FormInputError('INVALID_KEY', '');
  return /^(?:0|[1-9][0-9]{0,8})$/.test(part) ? Number(part) : part;
}

type Mutable = { [key: string]: Node } | Node[];
type Node = FormValue | Mutable;

/**
 * Normalize an `application/x-www-form-urlencoded` body into hardened nested
 * data. Works with flat parsers (`node:querystring`, Fastify's default, Express
 * `extended: false`: keys such as `items[0][name]`, `items.0.name`, `tags[]`) and
 * with already-nested `qs` output (Express `extended: true`). Prototype keys,
 * sparse or oversized arrays, conflicting shapes and unknown value types throw
 * {@link FormInputError}. Values are never coerced.
 */
export function parseFormBody(
  body: unknown,
  options: FormBodyOptions = {},
): Record<string, FormValue> {
  const bounds = resolveLimits(options.limits);
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new FormInputError('TYPE', '');
  if (!isPlainObject(body)) throw new FormInputError('TYPE', '');
  const omit = new Set(['_csrf', '_submission', ...(options.omit ?? [])]);
  const keys = Reflect.ownKeys(body);
  if (keys.length > bounds.maxKeys) throw new FormInputError('KEYS', '');
  const root: { [key: string]: Node } = {};
  for (const key of keys) {
    if (typeof key !== 'string') throw new FormInputError('INVALID_KEY', '');
    const descriptor = Object.getOwnPropertyDescriptor(body, key);
    if (!descriptor || !('value' in descriptor))
      throw new FormInputError('TYPE', '');
    const { segments, push } = segmentsOf(key);
    if (segments.length > bounds.maxDepth)
      throw new FormInputError('DEPTH', formatPath(segments));
    const head = segments[0];
    if (typeof head !== 'string') throw new FormInputError('INVALID_KEY', '');
    if (omit.has(head) && segments.length === 1) continue;
    const raw: unknown = descriptor.value;
    const value = hardenInput(raw, bounds);
    assign(
      root,
      segments,
      push ? (Array.isArray(value) ? value : [value]) : value,
      push,
      bounds.maxArrayLength,
    );
  }
  for (const field of options.arrays ?? []) {
    if (!safeKey(field)) throw new Error(`Invalid array field ${field}`);
    const current = root[field];
    if (current === undefined) root[field] = [];
    else if (typeof current === 'string') root[field] = [current];
  }
  // A final pass rejects sparse arrays and re-checks every bound on the merged tree.
  const merged = hardenInput(root, bounds);
  if (!isFormObject(merged)) throw new FormInputError('TYPE', '');
  return merged;
}

function assign(
  root: { [key: string]: Node },
  segments: readonly PathSegment[],
  value: FormValue,
  push: boolean,
  maxArrayLength: number,
): void {
  let container: Mutable = root;
  for (let index = 0; index < segments.length; index++) {
    const key = segments[index];
    if (key === undefined) break;
    const last = index === segments.length - 1;
    const nextKey = segments[index + 1];
    if (Array.isArray(container)) {
      if (typeof key !== 'number' || key >= maxArrayLength)
        throw new FormInputError(
          typeof key === 'number' ? 'ARRAY_LENGTH' : 'CONFLICT',
          formatPath(segments.slice(0, index + 1)),
        );
    } else if (typeof key === 'number' && index === 0)
      throw new FormInputError('INVALID_KEY', '');
    const existing: Node | undefined = Array.isArray(container)
      ? container[key as number]
      : container[String(key)];
    if (last) {
      if (existing !== undefined) {
        if (push && Array.isArray(existing) && Array.isArray(value)) {
          if (existing.length + value.length > maxArrayLength)
            throw new FormInputError('ARRAY_LENGTH', formatPath(segments));
          existing.push(...value);
          return;
        }
        throw new FormInputError('CONFLICT', formatPath(segments));
      }
      write(container, key, value);
      return;
    }
    let child: Node | undefined = existing;
    if (child === undefined) {
      child = typeof nextKey === 'number' ? [] : {};
      write(container, key, child);
    }
    if (child === null || typeof child !== 'object')
      throw new FormInputError(
        'CONFLICT',
        formatPath(segments.slice(0, index + 1)),
      );
    if (typeof nextKey === 'number' && !Array.isArray(child))
      throw new FormInputError(
        'CONFLICT',
        formatPath(segments.slice(0, index + 1)),
      );
    if (typeof nextKey === 'string' && Array.isArray(child))
      throw new FormInputError(
        'CONFLICT',
        formatPath(segments.slice(0, index + 1)),
      );
    container = child;
  }
}
function write(container: Mutable, key: PathSegment, value: Node): void {
  if (Array.isArray(container)) {
    if (typeof key !== 'number') throw new FormInputError('CONFLICT', '');
    // Assigning past the end creates holes; the final hardening pass rejects them.
    container[key] = value;
  } else {
    Object.defineProperty(container, String(key), {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
