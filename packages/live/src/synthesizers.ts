import type { JsonValue } from './protocol.js';

/**
 * Explicit, trusted conversion between a typed component field and its public
 * JSON snapshot form. Synthesizers are selected in server code only; the wire
 * never names a type or constructor.
 */
export interface StateSynthesizer<T = unknown> {
  readonly name: string;
  /** Convert the field value to bounded public JSON. */
  dehydrate(value: T): JsonValue;
  /** Rebuild the field from JSON; throw for malformed or out-of-range input. */
  hydrate(value: JsonValue): T;
}

const isoDate =
  /^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{3})?Z$/;

/** `Date` ⇄ UTC ISO-8601 string (`2026-11-01T10:00:00.000Z`). Invalid dates are rejected. */
export const DateSynthesizer: StateSynthesizer<Date> = Object.freeze({
  name: 'date',
  dehydrate(value: Date): JsonValue {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      throw new TypeError('Date state must hold a valid Date');
    return value.toISOString();
  },
  hydrate(value: JsonValue): Date {
    if (typeof value !== 'string' || !isoDate.test(value))
      throw new TypeError('Expected a UTC ISO-8601 date string');
    const date = new Date(value);
    const canonical = date.toISOString();
    // Reject rolled-over calendar values such as February 30.
    if (canonical !== value && canonical.replace('.000Z', 'Z') !== value)
      throw new TypeError('Expected a valid calendar date');
    return date;
  },
});

/** `bigint` ⇄ decimal string, bounded to 78 digits (256-bit range). */
export const BigIntSynthesizer: StateSynthesizer<bigint> = Object.freeze({
  name: 'bigint',
  dehydrate(value: bigint): JsonValue {
    if (typeof value !== 'bigint')
      throw new TypeError('BigInt state must hold a bigint');
    const text = value.toString();
    if (text.replace('-', '').length > 78)
      throw new RangeError('BigInt state is too large');
    return text;
  },
  hydrate(value: JsonValue): bigint {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,77})$/.test(value))
      throw new TypeError('Expected a decimal integer string');
    return BigInt(value);
  },
});

export function isSynthesizer(value: unknown): value is StateSynthesizer {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'name') === 'string' &&
    /^[a-z][a-z0-9-]{0,63}$/.test(String(Reflect.get(value, 'name'))) &&
    typeof Reflect.get(value, 'dehydrate') === 'function' &&
    typeof Reflect.get(value, 'hydrate') === 'function'
  );
}

/** Name, dehydrate and hydrate of a domain type; validated and frozen by {@link defineSynthesizer}. */
export interface SynthesizerDefinition<T> {
  readonly name: string;
  dehydrate(value: T): JsonValue;
  hydrate(value: JsonValue): T;
}

/**
 * Declare a typed synthesizer for a domain type (money, IDs, value objects).
 * `hydrate` receives untrusted client JSON on writable fields and must throw
 * for anything it does not accept; it never receives a constructor name.
 */
export function defineSynthesizer<T>(
  definition: SynthesizerDefinition<T>,
): StateSynthesizer<T> {
  if (!isSynthesizer(definition))
    throw new TypeError(
      'Synthesizers need a lowercase name plus dehydrate and hydrate functions',
    );
  const { name } = definition;
  const dehydrate = definition.dehydrate.bind(definition);
  const hydrate = definition.hydrate.bind(definition);
  return Object.freeze({ name, dehydrate, hydrate });
}

type EnumValue = string | number;

/** Restrict a field to a fixed set of strings/numbers, rejecting any other client value. */
export function enumSynthesizer<const Values extends readonly EnumValue[]>(
  values: Values,
): StateSynthesizer<Values[number]> {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 256 ||
    new Set(values).size !== values.length ||
    !values.every(
      (value: unknown) =>
        (typeof value === 'string' && value.length <= 256) ||
        (typeof value === 'number' && Number.isFinite(value)),
    )
  )
    throw new TypeError('enumSynthesizer needs 1–256 unique finite values');
  const allowed: readonly unknown[] = Object.freeze([...values]);
  const check = (value: unknown): Values[number] => {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      !allowed.includes(value)
    )
      throw new TypeError('Value is not one of the declared enum members');
    // includes() proved membership in the declared tuple.
    return value as Values[number];
  };
  return defineSynthesizer<Values[number]>({
    name: 'enum',
    dehydrate: check,
    hydrate: check,
  });
}

type Primitive = 'string' | 'number' | 'boolean';
function primitive(kind: Primitive): StateSynthesizer {
  const check = (value: unknown): JsonValue => {
    if (
      typeof value !== kind ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new TypeError(`Expected a ${kind}`);
    // The typeof check above narrows to the requested JSON scalar.
    return value as JsonValue;
  };
  return defineSynthesizer({ name: kind, dehydrate: check, hydrate: check });
}

/**
 * Allow `null` alongside an inner type. Plain writable state keeps its JSON
 * kind, so a `string | null` field needs this to move between null and text.
 */
export function nullableSynthesizer<T = JsonValue>(
  inner: StateSynthesizer<T> | Primitive,
): StateSynthesizer<T | null> {
  const base: StateSynthesizer<unknown> =
    typeof inner === 'string' ? primitive(inner) : inner;
  if (!isSynthesizer(base))
    throw new TypeError('nullableSynthesizer needs a synthesizer or primitive');
  return defineSynthesizer<T | null>({
    name: 'nullable',
    dehydrate: (value) => (value === null ? null : base.dehydrate(value)),
    // A primitive base returns the checked scalar; a typed base returns T.
    hydrate: (value) => (value === null ? null : (base.hydrate(value) as T)),
  });
}

function scalar(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw new TypeError(
    'Collection items must be JSON scalars or use an item synthesizer',
  );
}
function bound(maxItems: number): number {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 5_000)
    throw new TypeError('maxItems must be 1–5000');
  return maxItems;
}

/** `Set` ⇄ JSON array in insertion order; duplicates in client JSON are rejected. */
export function setSynthesizer<T = JsonValue>(
  options: {
    readonly item?: StateSynthesizer<T>;
    readonly maxItems?: number;
  } = {},
): StateSynthesizer<Set<T>> {
  const item = options.item;
  const max = bound(options.maxItems ?? 1_000);
  const read = (entry: JsonValue): T =>
    item ? item.hydrate(entry) : (scalar(entry) as T);
  return defineSynthesizer<Set<T>>({
    name: 'set',
    dehydrate(value) {
      if (!(value instanceof Set) || value.size > max)
        throw new TypeError('Set state must hold a bounded Set');
      return [...value].map((entry: T) =>
        item ? item.dehydrate(entry) : scalar(entry),
      );
    },
    hydrate(value) {
      if (!Array.isArray(value) || value.length > max)
        throw new TypeError('Expected a bounded JSON array');
      const keys = new Set(value.map((entry) => JSON.stringify(entry)));
      if (keys.size !== value.length)
        throw new TypeError('Set JSON must not contain duplicates');
      return new Set(value.map(read));
    },
  });
}

/** `Map<string, T>` ⇄ JSON array of `[key, value]` pairs (order kept, no prototype keys). */
export function mapSynthesizer<T = JsonValue>(
  options: {
    readonly value?: StateSynthesizer<T>;
    readonly maxItems?: number;
  } = {},
): StateSynthesizer<Map<string, T>> {
  const inner = options.value;
  const max = bound(options.maxItems ?? 1_000);
  const key = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 256)
      throw new TypeError('Map keys must be strings of at most 256 characters');
    return value;
  };
  return defineSynthesizer<Map<string, T>>({
    name: 'map',
    dehydrate(value) {
      if (!(value instanceof Map) || value.size > max)
        throw new TypeError('Map state must hold a bounded Map');
      return [...value].map(([name, entry]: [string, T]): JsonValue => [
        key(name),
        inner ? inner.dehydrate(entry) : scalar(entry),
      ]);
    },
    hydrate(value) {
      if (!Array.isArray(value) || value.length > max)
        throw new TypeError('Expected a bounded array of [key, value] pairs');
      const result = new Map<string, T>();
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2)
          throw new TypeError('Map entries must be [key, value] pairs');
        const [rawKey, entry] = pair;
        const name = key(rawKey);
        if (result.has(name) || entry === undefined)
          throw new TypeError('Duplicate or missing map entry');
        result.set(name, inner ? inner.hydrate(entry) : (scalar(entry) as T));
      }
      return result;
    },
  });
}
