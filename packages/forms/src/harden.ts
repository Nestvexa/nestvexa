import {
  FormInputError,
  forbiddenKeys,
  formatPath,
  safeKey,
} from './errors.js';
import type { PathSegment } from './errors.js';

/** Plain JSON data accepted from a form after hardening. */
export type FormValue =
  null | boolean | number | string | FormValue[] | { [key: string]: FormValue };

/** Resource bounds applied before any schema adapter runs. */
export interface InputLimits {
  /** Nesting depth of objects/arrays below the root. Default 8. */
  readonly maxDepth?: number;
  /** Own keys per object. Default 200. */
  readonly maxKeys?: number;
  /** Characters (UTF-16 code units) per string. Default 10000. */
  readonly maxStringLength?: number;
  /** Items per array. Default 500. */
  readonly maxArrayLength?: number;
  /** Total values visited. Default 5000. */
  readonly maxNodes?: number;
}

/** Defaults used whenever a limit is omitted. */
export const defaultInputLimits: Readonly<Required<InputLimits>> =
  Object.freeze({
    maxDepth: 8,
    maxKeys: 200,
    maxStringLength: 10_000,
    maxArrayLength: 500,
    maxNodes: 5_000,
  });

const ceilings: Readonly<Required<InputLimits>> = Object.freeze({
  maxDepth: 32,
  maxKeys: 10_000,
  maxStringLength: 1_048_576,
  maxArrayLength: 100_000,
  maxNodes: 1_000_000,
});

/** Validate and complete limits; invalid configuration fails at startup. */
export function resolveLimits(
  limits: InputLimits = {},
): Readonly<Required<InputLimits>> {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits))
    throw new Error('Input limits must be an object');
  const resolved = { ...defaultInputLimits };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(defaultInputLimits, key))
      throw new Error(`Unknown input limit ${key}`);
    const name = key as keyof InputLimits;
    const value: unknown = limits[name];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > ceilings[name]
    )
      throw new Error(
        `Input limit ${key} must be an integer 1–${ceilings[name]}`,
      );
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}

/**
 * Ordinary objects, null-prototype dictionaries, and dictionaries whose
 * prototype is an empty null-prototype object (the shape `fast-querystring`,
 * used by Nest's Fastify adapter, produces). Anything inheriting behaviour is refused.
 */
export function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return true;
  return (
    typeof prototype === 'object' &&
    Object.getPrototypeOf(prototype) === null &&
    Reflect.ownKeys(prototype).length === 0
  );
}

/**
 * Return a detached copy of `value` containing only plain JSON data, or throw a
 * {@link FormInputError}. Nothing is coerced: strings stay strings, numbers must
 * be finite, and `undefined`, functions, symbols, bigints, Dates, Maps, class
 * instances, getters, symbol keys and `__proto__`/`constructor`/`prototype` keys
 * are refused. Object keys must match `[A-Za-z0-9_-]{1,128}`. Output objects have
 * the ordinary prototype and only own data properties.
 */
export function hardenInput(value: unknown, limits?: InputLimits): FormValue {
  const bounds = resolveLimits(limits);
  const state = { nodes: 0 };
  return visit(value, [], 0, bounds, state);
}

function visit(
  value: unknown,
  path: PathSegment[],
  depth: number,
  bounds: Readonly<Required<InputLimits>>,
  state: { nodes: number },
): FormValue {
  if (++state.nodes > bounds.maxNodes)
    throw new FormInputError('NODES', formatPath(path));
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > bounds.maxStringLength)
      throw new FormInputError('STRING_LENGTH', formatPath(path));
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new FormInputError('TYPE', formatPath(path));
    return value;
  }
  if (typeof value !== 'object')
    throw new FormInputError('TYPE', formatPath(path));
  if (depth >= bounds.maxDepth)
    throw new FormInputError('DEPTH', formatPath(path));
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new FormInputError('TYPE', formatPath(path));
    const length = value.length;
    if (length > bounds.maxArrayLength)
      throw new FormInputError('ARRAY_LENGTH', formatPath(path));
    const keys = Reflect.ownKeys(value);
    // Indices plus `length`; anything else is a decorated or sparse array.
    if (keys.length !== length + 1)
      throw new FormInputError('SPARSE_ARRAY', formatPath(path));
    const result: FormValue[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor)
        throw new FormInputError('SPARSE_ARRAY', formatPath(path));
      if (!('value' in descriptor))
        throw new FormInputError('TYPE', formatPath([...path, index]));
      result.push(
        visit(descriptor.value, [...path, index], depth + 1, bounds, state),
      );
    }
    return result;
  }
  if (!isPlainObject(value)) throw new FormInputError('TYPE', formatPath(path));
  const keys = Reflect.ownKeys(value);
  if (keys.length > bounds.maxKeys)
    throw new FormInputError('KEYS', formatPath(path));
  const result: { [key: string]: FormValue } = {};
  for (const key of keys) {
    if (typeof key !== 'string')
      throw new FormInputError('INVALID_KEY', formatPath(path));
    if (forbiddenKeys.has(key))
      throw new FormInputError('FORBIDDEN_KEY', formatPath(path));
    if (!safeKey(key))
      throw new FormInputError('INVALID_KEY', formatPath(path));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Accessors are refused without being invoked.
    if (!descriptor || !('value' in descriptor))
      throw new FormInputError('TYPE', formatPath([...path, key]));
    result[key] = visit(
      descriptor.value,
      [...path, key],
      depth + 1,
      bounds,
      state,
    );
  }
  return result;
}

/** Type guard for a hardened object value. */
export function isFormObject(
  value: FormValue | undefined,
): value is { [key: string]: FormValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
