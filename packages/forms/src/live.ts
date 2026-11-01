import { BadRequestException } from '@nestjs/common';
import { describeLiveState } from '@nestvexa/live';
import { validateForm } from './adapter.js';
import type { SchemaAdapter, ValidationResult } from './adapter.js';
import {
  FormInputError,
  normalizeErrors,
  replaceErrors,
  safeKey,
} from './errors.js';
import type { FormErrors } from './errors.js';
import { hardenInput } from './harden.js';
import type { FormValue, InputLimits } from './harden.js';
import { recordSubmit, touchFields } from './state.js';
import type { FormMeta } from './state.js';

export interface LiveValidationOptions {
  /** Read-only `@State()` field receiving the error bag. Default `errors`. */
  readonly errorsField?: string;
  /**
   * Optional read-only `@State()` field holding a `FormMeta`
   * (`createFormMeta()`): submits are recorded and changed fields touched.
   */
  readonly metaField?: string;
  readonly limits?: InputLimits;
}

function fieldList(fields: readonly string[]): readonly string[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 200)
    throw new Error('Validate 1–200 Live state fields');
  if (
    new Set(fields).size !== fields.length ||
    fields.some((field) => typeof field !== 'string' || !safeKey(field))
  )
    throw new Error('Live validation fields must be unique state names');
  return fields;
}
function ownValue(component: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(component, field);
  if (!descriptor || !('value' in descriptor))
    throw new Error(`Live state ${field} must be an initialized data field`);
  return descriptor.value;
}
function serverField(component: object, field: string): void {
  const state = describeLiveState(component, field);
  if (!state || state.writable || state.synthesized)
    throw new Error(
      `${field} must be a read-only @State() field of a @LiveComponent (for example @State() ${field} = {})`,
    );
}

/**
 * Read declared, non-synthesized `@State` fields of a Live component into a
 * hardened plain object. Injected services and undeclared members are refused,
 * so a field list can never read server-only data.
 */
export function readLiveFields(
  component: object,
  fields: readonly string[],
  limits?: InputLimits,
): Record<string, FormValue> {
  const values: Record<string, unknown> = {};
  for (const field of fieldList(fields)) {
    const state = describeLiveState(component, field);
    if (!state)
      throw new Error(
        `${field} is not a declared @State() field of this component`,
      );
    if (state.synthesized)
      throw new Error(
        `${field} uses a synthesizer; validate its typed value inside the action instead`,
      );
    values[field] = ownValue(component, field);
  }
  try {
    const hardened = hardenInput(values, limits);
    return hardened !== null &&
      typeof hardened === 'object' &&
      !Array.isArray(hardened)
      ? hardened
      : {};
  } catch (error) {
    if (error instanceof FormInputError)
      throw new BadRequestException('Form state rejected');
    throw error;
  }
}

async function run<T>(
  component: object,
  adapter: SchemaAdapter<T>,
  fields: readonly string[],
  options: LiveValidationOptions,
): Promise<ValidationResult<T>> {
  const values = readLiveFields(component, fields, options.limits);
  try {
    return await validateForm(adapter, values, {
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  } catch (error) {
    if (error instanceof FormInputError)
      throw new BadRequestException('Form state rejected');
    throw error;
  }
}
function writeState(component: object, field: string, value: unknown): void {
  ownValue(component, field);
  Reflect.set(component, field, value);
}
function readErrors(component: object, field: string): FormErrors {
  return normalizeErrors(ownValue(component, field));
}

/**
 * Submit-time validation inside a Live `@Action`: validate the named top-level
 * state fields together (cross-field rules see every field), replace the error
 * bag, and return the typed value. Return early when `ok` is false:
 *
 * ```ts
 * @Action() async save() {
 *   const result = await validateLive(this, profile, ['name', 'email']);
 *   if (!result.ok) return;
 *   await this.users.update(this.userId, result.value);
 * }
 * ```
 *
 * Validation runs in the same serialized, revision-checked Live request as the
 * action, so a response for older input can never overwrite newer state.
 */
export async function validateLive<T>(
  component: object,
  adapter: SchemaAdapter<T>,
  fields: readonly string[],
  options: LiveValidationOptions = {},
): Promise<ValidationResult<T>> {
  const errorsField = options.errorsField ?? 'errors';
  serverField(component, errorsField);
  if (options.metaField !== undefined)
    serverField(component, options.metaField);
  const result = await run(component, adapter, fields, options);
  writeState(component, errorsField, result.ok ? {} : { ...result.errors });
  if (options.metaField !== undefined) {
    const meta = ownValue(component, options.metaField) as FormMeta;
    writeState(component, options.metaField, { ...recordSubmit(meta) });
  }
  return result;
}

/**
 * Live per-field validation, typically from the `afterUpdate` hook of a
 * `nv:model.blur`/`.live` synchronization. All `fields` are validated together
 * (so cross-field and async rules run), but only the entries of the changed
 * field(s) are replaced in the error bag. Returns `undefined`, doing nothing,
 * when no changed field is in `fields`.
 *
 * ```ts
 * async afterUpdate(update: LiveUpdateContext) {
 *   await validateField(this, profile, ['name', 'email'], update.field);
 * }
 * ```
 */
export async function validateField<T>(
  component: object,
  adapter: SchemaAdapter<T>,
  fields: readonly string[],
  changed: string | readonly string[],
  options: LiveValidationOptions = {},
): Promise<ValidationResult<T> | undefined> {
  const list = fieldList(fields);
  const selected = (
    typeof changed === 'string' ? [changed] : [...changed]
  ).filter((field) => list.includes(field));
  if (!selected.length) return undefined;
  const errorsField = options.errorsField ?? 'errors';
  serverField(component, errorsField);
  if (options.metaField !== undefined)
    serverField(component, options.metaField);
  const result = await run(component, adapter, list, options);
  writeState(component, errorsField, {
    ...replaceErrors(
      readErrors(component, errorsField),
      result.ok ? {} : result.errors,
      selected,
    ),
  });
  if (options.metaField !== undefined) {
    const meta = ownValue(component, options.metaField) as FormMeta;
    writeState(component, options.metaField, {
      ...touchFields(meta, selected),
    });
  }
  return result;
}
