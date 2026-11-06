import { validateForm } from './adapter.js';
import type { SchemaAdapter, ValidationResult } from './adapter.js';
import {
  FORM_ERROR,
  FormInputError,
  hasErrors,
  normalizeErrors,
  safeKey,
} from './errors.js';
import type { FormErrors } from './errors.js';
import { hardenInput } from './harden.js';
import type { FormValue, InputLimits } from './harden.js';
import type { FormHints } from './hints.js';
import { sameValue } from './state.js';
import { errorSummary, formView } from './view.js';
import type { ErrorSummary, FieldView, FieldViewOptions } from './view.js';

/** A file field holds upload references: `''`, one `nvu_…` token or a comma list. */
export interface FileFieldOptions {
  /** Maximum number of files. Default 1. */
  readonly max?: number;
}

/**
 * JSON state of one form instance. Store it in a read-only Live `@State()`
 * field or in the session; every operation returns a new frozen snapshot.
 */
export interface FormSnapshot {
  readonly values: Readonly<Record<string, FormValue>>;
  /** Baseline for `dirty`: the defaults, or the values passed to `create`/`reset`. */
  readonly initial: Readonly<Record<string, FormValue>>;
  readonly errors: FormErrors;
  /** Fields the user interacted with (sorted, unique). */
  readonly touched: readonly string[];
  /** Fields whose value differs from `initial` (declaration order). */
  readonly dirty: readonly string[];
  readonly submitted: boolean;
  readonly submitCount: number;
  /** True between `begin` and `finish`; a second `begin` is refused while true. */
  readonly pending: boolean;
}

export interface FormViewData {
  readonly values: Readonly<Record<string, FormValue>>;
  readonly fields: Readonly<Record<string, FieldView>>;
  readonly summary: ErrorSummary;
  readonly hints: FormHints;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly submitted: boolean;
  readonly valid: boolean;
}

export interface FormDefinitionOptions<T> {
  /** Field name -> default value. Order is the display and validation order. */
  readonly fields: Readonly<Record<string, FormValue>>;
  /** File fields (upload references) with their limits; default value `''`. */
  readonly files?: Readonly<Record<string, FileFieldOptions>>;
  readonly adapter?: SchemaAdapter<T>;
  /** Safe client hints, for example from `zodHints(schema)`. */
  readonly hints?: FormHints;
  readonly limits?: InputLimits;
}

/** Operations over {@link FormSnapshot}s of one form. */
export interface FormDefinition<T> {
  readonly fields: readonly string[];
  readonly fileFields: Readonly<Record<string, Required<FileFieldOptions>>>;
  readonly hints: FormHints;
  /** Fresh state; `values` (declared fields only) also become the dirty baseline. */
  create(values?: Readonly<Record<string, unknown>>): FormSnapshot;
  /** Change field values (declared fields only, hardened); unknown fields throw. */
  update(
    state: FormSnapshot,
    values: Readonly<Record<string, unknown>>,
  ): FormSnapshot;
  touch(state: FormSnapshot, fields: readonly string[]): FormSnapshot;
  /** Back to the baseline (or new baseline `values`), clearing errors and meta. */
  reset(
    state: FormSnapshot,
    values?: Readonly<Record<string, unknown>>,
  ): FormSnapshot;
  /** Empty every field (`''`, `[]`, `false`, `null` by default type) keeping the baseline. */
  clear(state: FormSnapshot): FormSnapshot;
  /** Start a submit: pending, submitted, submitCount + 1. Throws while pending. */
  begin(state: FormSnapshot): FormSnapshot;
  /** End a submit with the validation or handler result. */
  finish(
    state: FormSnapshot,
    outcome?: ValidationResult<unknown> | { readonly errors: FormErrors },
  ): FormSnapshot;
  /** Run the adapter over the current values (and file-field shape checks). */
  validate(state: FormSnapshot): Promise<{
    readonly state: FormSnapshot;
    readonly result: ValidationResult<T>;
  }>;
  /**
   * begin → validate → `handle(value)` → finish. `handle` may return errors
   * (for example from `uploadFormErrors`) to show them as a failed submit.
   */
  submit(
    state: FormSnapshot,
    handle: (value: T) =>
      | void
      | { readonly errors: FormErrors }
      | Promise<void | {
          readonly errors: FormErrors;
        }>,
  ): Promise<{ readonly state: FormSnapshot; readonly ok: boolean }>;
  /** Upload tokens of a file field, shape-checked (finalization still verifies them). */
  files(state: FormSnapshot, field: string): readonly string[];
  view(state: FormSnapshot, options?: FieldViewOptions): FormViewData;
}

/** Same shape as `@nestvexa/uploads` `UPLOAD_TOKEN_PATTERN`; no package dependency. */
const uploadToken = /^nvu_[A-Za-z0-9_-]{43}$/;

function cleared(value: FormValue): FormValue {
  if (typeof value === 'string') return '';
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return [];
  if (value !== null && typeof value === 'object') return {};
  return null;
}
function plainRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Define a form once: fields with defaults, optional file fields, the schema
 * adapter and client hints. The definition is stateless; snapshots are data.
 *
 * ```ts
 * const profile = defineForm({ fields: { name: '', email: '' }, files: { avatar: {} }, adapter });
 * @State() form = profile.create();
 * ```
 */
export function defineForm<T>(
  options: FormDefinitionOptions<T>,
): FormDefinition<T> {
  const defaults = hardenInput(
    plainRecord(options.fields, 'fields'),
    options.limits,
  );
  if (
    defaults === null ||
    typeof defaults !== 'object' ||
    Array.isArray(defaults)
  )
    throw new Error('fields must be an object');
  const fileFields: Record<string, Required<FileFieldOptions>> = {};
  for (const [name, file] of Object.entries(
    plainRecord(options.files ?? {}, 'files'),
  )) {
    const max: unknown =
      file !== null && typeof file === 'object'
        ? (Reflect.get(file, 'max') ?? 1)
        : undefined;
    if (
      !safeKey(name) ||
      typeof max !== 'number' ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > 100
    )
      throw new Error(`Invalid file field ${name}`);
    fileFields[name] = Object.freeze({ max });
  }
  const base: Record<string, FormValue> = { ...defaults };
  for (const name of Object.keys(fileFields)) {
    if (Object.hasOwn(base, name))
      throw new Error(`File field ${name} is also a value field`);
    base[name] = '';
  }
  const fields = Object.freeze(Object.keys(base));
  if (!fields.length) throw new Error('A form needs at least one field');
  if (fields.length > 200)
    throw new Error('A form may declare at most 200 fields');
  const hints = Object.freeze({ ...(options.hints ?? {}) });
  const freeze = (
    values: Readonly<Record<string, FormValue>>,
  ): Readonly<Record<string, FormValue>> => Object.freeze({ ...values });

  /**
   * Declared fields only, hardened; missing fields keep `fallback`. Strict
   * mode (caller-supplied values) refuses undeclared fields; stored snapshots
   * drop them.
   */
  const pick = (
    input: Readonly<Record<string, unknown>>,
    fallback: Readonly<Record<string, FormValue>>,
    strict = true,
  ): Record<string, FormValue> => {
    const record = plainRecord(input, 'Form values');
    const declared: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (fields.includes(key)) declared[key] = record[key];
      else if (strict) throw new FormInputError('INVALID_KEY', key);
    }
    const hardened = hardenInput(declared, options.limits);
    const next: Record<string, FormValue> = { ...fallback };
    if (
      hardened !== null &&
      typeof hardened === 'object' &&
      !Array.isArray(hardened)
    )
      for (const key of fields)
        if (Object.hasOwn(hardened, key)) next[key] = hardened[key] ?? null;
    return next;
  };
  const dirtyOf = (
    values: Readonly<Record<string, FormValue>>,
    initial: Readonly<Record<string, FormValue>>,
  ): readonly string[] =>
    Object.freeze(
      fields.filter((field) => !sameValue(values[field], initial[field])),
    );
  /**
   * Snapshots usually come back from Live state or a session: rebuild them from
   * declared fields so stray or malformed members never propagate.
   */
  const read = (state: FormSnapshot): FormSnapshot => {
    const record = plainRecord(state, 'Form state');
    const initial = pick(
      plainRecord(Reflect.get(record, 'initial') ?? {}, 'initial'),
      base,
      false,
    );
    const values = pick(
      plainRecord(Reflect.get(record, 'values') ?? {}, 'values'),
      initial,
      false,
    );
    const touched: unknown = Reflect.get(record, 'touched');
    const count: unknown = Reflect.get(record, 'submitCount');
    return snapshot({
      values,
      initial,
      errors: normalizeErrors(Reflect.get(record, 'errors') ?? {}),
      touched: Array.isArray(touched)
        ? touched.filter(
            (field): field is string =>
              typeof field === 'string' && fields.includes(field),
          )
        : [],
      submitted: Reflect.get(record, 'submitted') === true,
      submitCount:
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
          ? count
          : 0,
      pending: Reflect.get(record, 'pending') === true,
    });
  };
  const snapshot = (parts: Omit<FormSnapshot, 'dirty'>): FormSnapshot => {
    const values = freeze(parts.values);
    const initial = freeze(parts.initial);
    return Object.freeze({
      values,
      initial,
      errors: parts.errors,
      touched: Object.freeze([...new Set(parts.touched)].sort()),
      dirty: dirtyOf(values, initial),
      submitted: parts.submitted,
      submitCount: parts.submitCount,
      pending: parts.pending,
    });
  };
  const fresh = (initial: Record<string, FormValue>): FormSnapshot =>
    snapshot({
      values: initial,
      initial,
      errors: normalizeErrors({}),
      touched: [],
      submitted: false,
      submitCount: 0,
      pending: false,
    });
  const tokens = (state: FormSnapshot, field: string): readonly string[] => {
    const file = fileFields[field];
    if (!file) throw new Error(`${field} is not a file field`);
    const value = state.values[field];
    if (value === '' || value === null || value === undefined)
      return Object.freeze([]);
    const list = typeof value === 'string' ? value.split(',') : undefined;
    if (
      !list ||
      list.length > file.max ||
      new Set(list).size !== list.length ||
      !list.every((token) => uploadToken.test(token))
    )
      throw new FormInputError('TYPE', field);
    return Object.freeze(list);
  };
  const fileErrors = (state: FormSnapshot): Record<string, string[]> => {
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(fileFields))
      try {
        tokens(state, field);
      } catch {
        errors[field] = ['Upload the file again.'];
      }
    return errors;
  };
  const definition: FormDefinition<T> = {
    fields,
    fileFields: Object.freeze(fileFields),
    hints,
    create: (values = {}) => fresh(pick(values, base)),
    update(state, values) {
      const current = read(state);
      return snapshot({ ...current, values: pick(values, current.values) });
    },
    touch(state, touched) {
      const current = read(state);
      for (const field of touched)
        if (!fields.includes(field))
          throw new FormInputError('INVALID_KEY', field);
      return snapshot({
        ...current,
        touched: [...current.touched, ...touched],
      });
    },
    reset(state, values) {
      const current = read(state);
      return fresh(
        values === undefined ? { ...current.initial } : pick(values, base),
      );
    },
    clear(state) {
      const current = read(state);
      const values: Record<string, FormValue> = {};
      for (const field of fields) values[field] = cleared(base[field] ?? null);
      return snapshot({
        ...current,
        values,
        errors: normalizeErrors({}),
        touched: [],
        submitted: false,
        pending: false,
      });
    },
    begin(state) {
      const current = read(state);
      if (current.pending)
        throw new Error('This form is already being submitted');
      return snapshot({
        ...current,
        pending: true,
        submitted: true,
        submitCount: Math.min(current.submitCount + 1, Number.MAX_SAFE_INTEGER),
      });
    },
    finish(state, outcome) {
      const current = read(state);
      const errors =
        outcome === undefined || ('ok' in outcome && outcome.ok)
          ? {}
          : 'errors' in outcome
            ? outcome.errors
            : {};
      return snapshot({
        ...current,
        pending: false,
        errors: normalizeErrors(errors),
      });
    },
    async validate(state) {
      const current = read(state);
      const shape = fileErrors(current);
      let result: ValidationResult<T>;
      if (options.adapter)
        result = await validateForm(options.adapter, current.values, {
          ...(options.limits === undefined ? {} : { limits: options.limits }),
        });
      else
        result = Object.freeze({
          ok: true as const,
          value: current.values as T,
        });
      if (Object.keys(shape).length)
        result = Object.freeze({
          ok: false as const,
          errors: normalizeErrors({
            ...(result.ok ? {} : result.errors),
            ...shape,
          }),
        });
      return {
        state: snapshot({
          ...current,
          errors: result.ok ? normalizeErrors({}) : result.errors,
        }),
        result,
      };
    },
    async submit(state, handle) {
      let current = definition.begin(state);
      try {
        const validated = await definition.validate(current);
        current = validated.state;
        if (!validated.result.ok)
          return {
            state: definition.finish(current, validated.result),
            ok: false,
          };
        const outcome = await handle(validated.result.value);
        if (outcome && hasErrors(outcome.errors))
          return { state: definition.finish(current, outcome), ok: false };
        return { state: definition.finish(current), ok: true };
      } catch (error) {
        // Never leave a snapshot stuck in `pending`.
        if (error instanceof FormInputError)
          return {
            state: definition.finish(current, {
              errors: {
                [FORM_ERROR]: ['The submitted values could not be read.'],
              },
            }),
            ok: false,
          };
        throw error;
      }
    },
    files: (state, field) => tokens(read(state), field),
    view(state, viewOptions = {}) {
      const current = read(state);
      const visible = current.submitted ? [...fields] : current.touched;
      return Object.freeze({
        values: current.values,
        fields: formView(current.errors, fields, { visible, ...viewOptions }),
        summary: errorSummary(current.errors, {
          ...(viewOptions.idPrefix === undefined
            ? {}
            : { idPrefix: viewOptions.idPrefix }),
          order: fields,
        }),
        hints,
        dirty: current.dirty.length > 0,
        pending: current.pending,
        submitted: current.submitted,
        valid: !hasErrors(current.errors),
      });
    },
  };
  return Object.freeze(definition);
}
