import { FORBIDDEN_KEYS } from './constants.js';
import { InertiaConfigurationError } from './errors.js';
import { hasControlCharacter } from './text.js';

/** Field errors: each key maps to one message or a list of messages. */
export type InertiaErrors = Readonly<
  Record<string, string | readonly string[]>
>;

/** Stored shape: error bag name -> field -> messages. */
export type StoredErrorBags = Record<string, Record<string, string[]>>;

const limits = { fields: 500, messages: 50, length: 2000, key: 256 };

/**
 * Normalizes caller-supplied errors to `field -> string[]`, rejecting values
 * that are not plain strings and keys that could pollute prototypes.
 */
export function normalizeErrors(errors: unknown): Record<string, string[]> {
  if (typeof errors !== 'object' || errors === null || Array.isArray(errors))
    throw new InertiaConfigurationError('Validation errors must be an object');
  const entries = Object.entries(errors);
  if (entries.length > limits.fields)
    throw new InertiaConfigurationError('Too many validation error fields');
  const result: Record<string, string[]> = {};
  for (const [field, value] of entries) {
    if (
      field === '' ||
      field.length > limits.key ||
      field.split('.').some((segment) => FORBIDDEN_KEYS.has(segment))
    )
      throw new InertiaConfigurationError('Invalid validation error field');
    const messages = typeof value === 'string' ? [value] : value;
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > limits.messages ||
      !messages.every(
        (m): m is string => typeof m === 'string' && m.length <= limits.length,
      )
    )
      throw new InertiaConfigurationError(
        'Validation messages must be strings',
      );
    result[field] = [...messages];
  }
  return result;
}

/** Validates an error bag name. */
export function assertBagName(bag: unknown): string {
  if (
    typeof bag !== 'string' ||
    bag === '' ||
    bag.length > 128 ||
    bag.includes('.') ||
    FORBIDDEN_KEYS.has(bag) ||
    hasControlCharacter(bag)
  )
    throw new InertiaConfigurationError('Invalid error bag name');
  return bag;
}

/** Reads stored bags defensively (session contents are host-persisted data). */
export function readStoredBags(value: unknown): StoredErrorBags {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {};
  const bags: StoredErrorBags = {};
  for (const [bag, fields] of Object.entries(value)) {
    try {
      bags[assertBagName(bag)] = normalizeErrors(fields);
    } catch {
      // Corrupt or foreign session data is ignored rather than rendered.
    }
  }
  return bags;
}
