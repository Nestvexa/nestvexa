import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import type { ComponentDefinition, ComputedDefinition } from './metadata.js';
import { cloneState, freezeJson, LiveProtocolError } from './protocol.js';
import type { JsonValue } from './protocol.js';

interface Entry {
  readonly key: string;
  readonly value: JsonValue | Promise<JsonValue>;
  expires: number;
}
function json(value: unknown): JsonValue {
  const result = cloneState({ value })['value'];
  if (result === undefined)
    throw new Error('Computed values must be JSON data');
  return result;
}
async function limited(
  value: unknown,
  milliseconds: number,
): Promise<JsonValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value).then((result) => freezeJson(json(result))),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new LiveProtocolError(
                'COMPUTED_TIMEOUT',
                504,
                'Computed evaluation deadline exceeded',
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Install instance-local readers after DI resolution; no module-level value cache. */
export function prepareComputed(
  instance: object,
  component: ComponentDefinition,
  clock: () => number = () => performance.now(),
): () => void {
  const entries = new Map<string, Entry>();
  const active = new Set<string>();
  function keyFor(entry: ComputedDefinition): string {
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const field of entry.dependencies ?? component.states.keys()) {
      const descriptor = Object.getOwnPropertyDescriptor(instance, field);
      if (!descriptor || !('value' in descriptor))
        throw new Error(
          `Computed dependency ${field} must be an initialized data field`,
        );
      values[field] = descriptor.value;
    }
    // Distinguish signed zero without colliding with ordinary strings that resemble a marker.
    return JSON.stringify(cloneState(values), (_key, value: unknown) =>
      typeof value === 'string'
        ? 's' + value
        : typeof value === 'number' && Object.is(value, -0)
          ? 'n-0'
          : value,
    );
  }
  function evaluate(
    name: string,
    definition: ComputedDefinition,
  ): JsonValue | Promise<JsonValue> {
    if (active.has(name)) throw new Error('Circular computed evaluation');
    const key = definition.cache ? keyFor(definition) : '';
    const previous = entries.get(name);
    if (previous && previous.key === key && clock() < previous.expires) {
      return previous.value instanceof Promise
        ? previous.value.then(json)
        : json(previous.value);
    }
    entries.delete(name);
    active.add(name);
    try {
      const result: unknown = Reflect.apply(definition.read, instance, []);
      if (!definition.async) {
        if (types.isPromise(result)) {
          void result.catch(() => undefined);
          throw new Error(
            'Computed getters must be synchronous; use an async:true method',
          );
        }
        const value = freezeJson(json(result));
        if (definition.cache)
          entries.set(name, {
            key,
            value,
            expires: clock() + (definition.ttl ?? Infinity),
          });
        return json(value);
      }
      const value = limited(result, definition.timeoutMs);
      const entry: Entry = { key, value, expires: Infinity };
      if (definition.cache) entries.set(name, entry);
      return value.then(
        (resolved) => {
          entry.expires = clock() + (definition.ttl ?? Infinity);
          return json(resolved);
        },
        (error: unknown) => {
          if (entries.get(name) === entry) entries.delete(name);
          throw error;
        },
      );
    } finally {
      active.delete(name);
    }
  }
  for (const [name, definition] of component.computed) {
    if (Object.hasOwn(instance, name))
      throw new Error(
        `Computed ${name} must not be shadowed by an instance field`,
      );
    if (definition.async)
      Object.defineProperty(instance, name, {
        configurable: true,
        value: (...args: unknown[]) => {
          if (args.length)
            throw new Error('Computed methods do not accept arguments');
          return evaluate(name, definition);
        },
      });
    else
      Object.defineProperty(instance, name, {
        configurable: true,
        get: () => evaluate(name, definition),
      });
  }
  return () => entries.clear();
}
