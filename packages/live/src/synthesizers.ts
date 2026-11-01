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
