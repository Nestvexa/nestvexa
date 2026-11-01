import { LiveClientError } from './grammar.js';

/** A detached JSON value, never a DOM event, service object or executable expression. */
export type LiveActionInput =
  | null
  | boolean
  | number
  | string
  | readonly LiveActionInput[]
  | { readonly [key: string]: LiveActionInput };
const limits = Object.freeze({ bytes: 16_384, nodes: 1000, depth: 8 });
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

/** Validate without invoking getters/toJSON, and freeze a detached value before it enters the queue. */
export function cloneActionInput(input: unknown): LiveActionInput {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const encoder = new TextEncoder();
  const invalid = (): never => {
    throw new LiveClientError(
      'DIRECTIVE',
      'Action input must be bounded plain JSON data',
    );
  };
  const add = (amount: number): void => {
    if ((bytes += amount) > limits.bytes) invalid();
  };
  const string = (value: string): void => {
    if (value.length > limits.bytes) invalid();
    add(encoder.encode(JSON.stringify(value)).byteLength);
  };
  const copy = (value: unknown, depth: number): LiveActionInput => {
    if (++nodes > limits.nodes || depth > limits.depth) return invalid();
    if (value === null || typeof value === 'boolean') {
      add(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === 'string') {
      string(value);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      add(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== 'object' || active.has(value)) return invalid();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.nodes + (array ? 1 : 0)) return invalid();
    active.add(value);
    add(2);
    if (array) {
      if (value.length > limits.nodes || keys.length !== value.length + 1)
        return invalid();
      const result: LiveActionInput[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          return invalid();
        if (index) add(1);
        result.push(copy(descriptor.value, depth + 1));
      }
      active.delete(value);
      return Object.freeze(result);
    }
    const result = Object.create(null) as Record<string, LiveActionInput>;
    let index = 0;
    for (const key of keys) {
      if (typeof key !== 'string' || forbidden.has(key)) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        return invalid();
      if (index++) add(1);
      string(key);
      add(1);
      result[key] = copy(descriptor.value, depth + 1);
    }
    active.delete(value);
    return Object.freeze(result);
  };
  return copy(input, 0);
}
