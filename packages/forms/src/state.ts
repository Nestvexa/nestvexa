import { FormInputError, formatPath, parsePath, safeKey } from './errors.js';
import type { PathSegment } from './errors.js';
import { hardenInput } from './harden.js';
import type { FormValue } from './harden.js';

/**
 * JSON interaction state of a form. Store it in Live state (`@State() form =
 * createFormMeta()`) or a session; all helpers return new frozen objects.
 */
export interface FormMeta {
  /** Top-level fields the user has interacted with (bounded, unique, sorted). */
  readonly touched: readonly string[];
  /** True after the first submit attempt, valid or not. */
  readonly submitted: boolean;
  readonly submitCount: number;
}

const maxTouched = 200;

export function createFormMeta(): FormMeta {
  return Object.freeze({
    touched: Object.freeze([]),
    submitted: false,
    submitCount: 0,
  });
}
function readMeta(meta: unknown): FormMeta {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
    return createFormMeta();
  const touched: unknown = Reflect.get(meta, 'touched');
  const submitted: unknown = Reflect.get(meta, 'submitted');
  const count: unknown = Reflect.get(meta, 'submitCount');
  return Object.freeze({
    touched: Object.freeze(
      Array.isArray(touched)
        ? [
            ...new Set(
              touched.filter(
                (field): field is string =>
                  typeof field === 'string' && safeKey(field),
              ),
            ),
          ]
            .sort()
            .slice(0, maxTouched)
        : [],
    ),
    submitted: submitted === true,
    submitCount:
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? count
        : 0,
  });
}

/** Mark fields as touched. */
export function touchFields(
  meta: FormMeta,
  fields: readonly string[],
): FormMeta {
  const current = readMeta(meta);
  for (const field of fields)
    if (!safeKey(field)) throw new Error(`Invalid field ${String(field)}`);
  return Object.freeze({
    ...current,
    touched: Object.freeze(
      [...new Set([...current.touched, ...fields])].sort().slice(0, maxTouched),
    ),
  });
}

/** Record a submit attempt. */
export function recordSubmit(meta: FormMeta): FormMeta {
  const current = readMeta(meta);
  return Object.freeze({
    ...current,
    submitted: true,
    submitCount: Math.min(current.submitCount + 1, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * Fields whose errors should be visible: every field after a submit attempt,
 * otherwise only touched ones. Pass to `fieldView(..., { visible })`.
 */
export function visibleFields(
  meta: FormMeta,
  fields: readonly string[],
): readonly string[] {
  const current = readMeta(meta);
  return Object.freeze(
    current.submitted
      ? [...fields]
      : fields.filter((field) => current.touched.includes(field)),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
/** JSON-structural equality (object key order ignored). */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/** Fields whose current value differs structurally from the initial value. */
export function dirtyFields(
  initial: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): readonly string[] {
  return Object.freeze(
    fields.filter(
      (field) =>
        !sameValue(
          Object.hasOwn(initial, field) ? initial[field] : undefined,
          Object.hasOwn(current, field) ? current[field] : undefined,
        ),
    ),
  );
}

/** Read a nested value by dotted path; `undefined` when absent. */
export function getPath(
  value: FormValue,
  path: string | readonly PathSegment[],
): FormValue | undefined {
  const segments = typeof path === 'string' ? parsePath(path) : [...path];
  let current: FormValue | undefined = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return undefined;
      current = current[segment];
    } else {
      const key = String(segment);
      current = Object.hasOwn(current, key) ? current[key] : undefined;
    }
  }
  return current;
}

/**
 * Return a hardened copy of `value` with `path` set to `next`. Intermediate
 * containers are created (arrays for numeric segments); indices may append but
 * never create holes; prototype keys are refused.
 */
export function setPath(
  value: FormValue,
  path: string | readonly PathSegment[],
  next: FormValue,
): FormValue {
  const segments = typeof path === 'string' ? parsePath(path) : [...path];
  if (!segments.length) throw new FormInputError('INVALID_KEY', '');
  return hardenInput(write(hardenInput(value), segments, hardenInput(next), 0));
}
function write(
  container: FormValue,
  segments: readonly PathSegment[],
  next: FormValue,
  index: number,
): FormValue {
  const segment = segments[index];
  if (segment === undefined) return next;
  const following = segments[index + 1];
  if (typeof segment === 'number') {
    if (!Number.isSafeInteger(segment) || segment < 0)
      throw new FormInputError('INVALID_KEY', formatPath(segments));
    const list = Array.isArray(container) ? [...container] : null;
    if (!list) throw new FormInputError('CONFLICT', formatPath(segments));
    if (segment > list.length)
      throw new FormInputError('SPARSE_ARRAY', formatPath(segments));
    const child = list[segment] ?? (typeof following === 'number' ? [] : {});
    list[segment] = write(child, segments, next, index + 1);
    return list;
  }
  if (!safeKey(segment))
    throw new FormInputError('INVALID_KEY', formatPath(segments));
  if (
    container === null ||
    typeof container !== 'object' ||
    Array.isArray(container)
  )
    throw new FormInputError('CONFLICT', formatPath(segments));
  const copy: { [key: string]: FormValue } = { ...container };
  const child = Object.hasOwn(copy, segment)
    ? (copy[segment] ?? null)
    : typeof following === 'number'
      ? []
      : {};
  copy[segment] = write(child, segments, next, index + 1);
  return copy;
}

/** Options for repeater (array) helpers. */
export interface RepeaterOptions {
  /** Maximum items after the change. Default 50. */
  readonly max?: number;
}

/** Insert `item` at `index` (0…length) and return a new array. */
export function insertItem(
  list: readonly FormValue[],
  index: number,
  item: FormValue,
  options: RepeaterOptions = {},
): FormValue[] {
  const max = options.max ?? 50;
  if (!Number.isSafeInteger(index) || index < 0 || index > list.length)
    throw new RangeError('Repeater index out of range');
  if (list.length + 1 > max) throw new RangeError('Repeater is full');
  const copy = [...list];
  copy.splice(index, 0, hardenInput(item));
  return copy;
}
/** Remove the item at `index` and return a new array. */
export function removeItem(
  list: readonly FormValue[],
  index: number,
): FormValue[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= list.length)
    throw new RangeError('Repeater index out of range');
  return list.filter((_, position) => position !== index);
}
/** Move an item from `from` to `to` and return a new array. */
export function moveItem(
  list: readonly FormValue[],
  from: number,
  to: number,
): FormValue[] {
  for (const index of [from, to])
    if (!Number.isSafeInteger(index) || index < 0 || index >= list.length)
      throw new RangeError('Repeater index out of range');
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  if (item === undefined) throw new RangeError('Repeater index out of range');
  copy.splice(to, 0, item);
  return copy;
}
