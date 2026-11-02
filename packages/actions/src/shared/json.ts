import type { JsonValue } from './protocol.js';

/** Keys that can reach prototype mutation in naive merge/assign code. */
export const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface JsonInputLimits {
  /** Maximum container nesting depth (the top-level value is depth 1). */
  readonly maxDepth: number;
  /** Maximum number of values (containers plus leaves). */
  readonly maxNodes: number;
}

export type JsonInputProblem = 'DEPTH' | 'NODES' | 'FORBIDDEN_KEY' | 'NOT_JSON';
export type JsonInputInspection =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: JsonInputProblem };

function plainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Inspects an already parsed request body without recursion, so an adversarial
 * nesting depth cannot exhaust the call stack. Accessors are never evaluated.
 */
export function inspectJsonInput(
  value: unknown,
  limits: JsonInputLimits,
): JsonInputInspection {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (++nodes > limits.maxNodes) return { ok: false, problem: 'NODES' };
    const item = current.value;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      continue;
    if (typeof item !== 'object') return { ok: false, problem: 'NOT_JSON' };
    if (current.depth > limits.maxDepth) return { ok: false, problem: 'DEPTH' };
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype)
        return { ok: false, problem: 'NOT_JSON' };
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !('value' in descriptor))
          return { ok: false, problem: 'NOT_JSON' };
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }
    if (!plainPrototype(item)) return { ok: false, problem: 'NOT_JSON' };
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') return { ok: false, problem: 'NOT_JSON' };
      if (FORBIDDEN_JSON_KEYS.has(key))
        return { ok: false, problem: 'FORBIDDEN_KEY' };
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor))
        return { ok: false, problem: 'NOT_JSON' };
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return { ok: true };
}

export interface JsonOutputLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}
export type JsonOutputResult =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly path: string;
      readonly problem: string;
    };

class OutputRejection extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(problem);
  }
}

function describePath(path: readonly (string | number)[]): string {
  return path.length === 0
    ? '$'
    : '$' +
        path
          .map((segment) =>
            typeof segment === 'number'
              ? `[${segment}]`
              : /^[A-Za-z_$][\w$]*$/.test(segment)
                ? `.${segment}`
                : `[${JSON.stringify(segment)}]`,
          )
          .join('');
}

/**
 * Produces a detached JSON copy of an action result, rejecting values that
 * `JSON.stringify` would silently corrupt or that indicate an accidental leak:
 * functions, symbols, bigints, non-finite numbers, cycles, `undefined` array
 * items and class instances (Map, Set, entities, errors) unless the object
 * explicitly serializes itself with `toJSON()` (for example `Date`).
 */
export function toJsonSafe(
  value: unknown,
  limits: JsonOutputLimits,
): JsonOutputResult {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (
    input: unknown,
    path: (string | number)[],
    serialized: boolean,
  ): JsonValue | undefined => {
    if (++nodes > limits.maxNodes)
      throw new OutputRejection(describePath(path), 'too many values');
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean'
    )
      return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new OutputRejection(describePath(path), 'non-finite number');
      return input;
    }
    if (input === undefined) return undefined;
    if (typeof input !== 'object')
      throw new OutputRejection(describePath(path), `${typeof input} value`);
    if (path.length >= limits.maxDepth)
      throw new OutputRejection(describePath(path), 'nesting too deep');
    if (ancestors.has(input))
      throw new OutputRejection(describePath(path), 'circular reference');
    const toJson: unknown = Reflect.get(input, 'toJSON');
    if (!serialized && typeof toJson === 'function') {
      const replacement: unknown = Reflect.apply(toJson, input, [
        path.length === 0 ? '' : String(path[path.length - 1]),
      ]);
      ancestors.add(input);
      try {
        return visit(replacement, path, true);
      } finally {
        ancestors.delete(input);
      }
    }
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype)
          throw new OutputRejection(describePath(path), 'array subclass');
        const result: JsonValue[] = [];
        for (let index = 0; index < input.length; index++) {
          const item = visit(input[index], [...path, index], false);
          if (item === undefined)
            throw new OutputRejection(
              describePath([...path, index]),
              'undefined array item',
            );
          result.push(item);
        }
        return result;
      }
      if (!plainPrototype(input))
        throw new OutputRejection(
          describePath(path),
          'class instance without toJSON()',
        );
      const result: Record<string, JsonValue> = {};
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string')
          throw new OutputRejection(describePath(path), 'symbol key');
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable) continue;
        if (key === '__proto__')
          throw new OutputRejection(describePath(path), 'forbidden key');
        const item = visit(Reflect.get(input, key), [...path, key], false);
        if (item !== undefined)
          Object.defineProperty(result, key, {
            value: item,
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return result;
    } finally {
      ancestors.delete(input);
    }
  };
  try {
    const result = visit(value, [], false);
    return { ok: true, value: result === undefined ? null : result };
  } catch (error) {
    if (error instanceof OutputRejection)
      return { ok: false, path: error.path, problem: error.problem };
    throw error;
  }
}

/** Deterministic JSON text with sorted object keys, used for fingerprints. */
export function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
