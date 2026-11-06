import { formatPath, safeKey } from './errors.js';

/**
 * Client validation hints derived from the server schema. They only add
 * browser conveniences (`required`, `minlength`, `pattern`, ...); the server
 * validates every submission again. Hints are generated conservatively: when
 * a rule cannot be expressed exactly (regex flags, exclusive bounds,
 * alternations), it is left out so the browser is never stricter than the
 * server.
 */
export interface FieldHint {
  readonly required: boolean;
  /** Input type implied by the schema. */
  readonly type?: 'email' | 'url' | 'number';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** HTML `pattern` (anchored implicitly by the browser). */
  readonly pattern?: string;
}
/** Hints keyed by dotted field path. */
export type FormHints = Readonly<Record<string, FieldHint>>;

type MutableHint = { -readonly [K in keyof FieldHint]: FieldHint[K] };
const maxPatternLength = 500;

function count(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
/**
 * HTML patterns are `^(?:p)$` with the `v` flag. Only anchored sources without
 * top-level-changing constructs are converted; everything else is dropped.
 */
function htmlPattern(source: string, flags = ''): string | undefined {
  if (
    flags.replace(/[uv]/g, '') !== '' ||
    source.length > maxPatternLength ||
    !source.startsWith('^') ||
    !source.endsWith('$') ||
    source.endsWith('\\$')
  )
    return undefined;
  const inner = source.slice(1, -1);
  // Outside escapes and character classes, `|`, `^` and `$` would change the
  // meaning once the browser wraps the pattern in `^(?:...)$`.
  const structure = inner
    .replace(/\\./g, '')
    .replace(/\[(?:[^\]\\]|\\.)*\]/g, '');
  if (/[|^$]/.test(structure)) return undefined;
  try {
    new RegExp(`^(?:${inner})$`, 'v');
  } catch {
    return undefined;
  }
  return inner;
}
function freezeHint(hint: MutableHint): FieldHint {
  return Object.freeze({ ...hint });
}

/**
 * Hints from a JSON Schema object (draft 2020-12 subset): `properties`,
 * `required`, `type`, `minLength`, `maxLength`, `minimum`, `maximum`,
 * `multipleOf`, `pattern` and `format` (`email`, `uri`). Nested objects
 * produce dotted paths; arrays are skipped. JSON Schema patterns carry no
 * flags, so pass `patterns: false` when the producer may drop them.
 */
export function hintsFromJsonSchema(
  schema: unknown,
  options: { readonly patterns?: boolean } = {},
): FormHints {
  const hints: Record<string, FieldHint> = {};
  const visit = (
    node: unknown,
    path: readonly string[],
    depth: number,
  ): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    const properties: unknown = Reflect.get(node, 'properties');
    if (properties === null || typeof properties !== 'object') return;
    const requiredList: unknown = Reflect.get(node, 'required');
    const required = new Set(
      Array.isArray(requiredList)
        ? requiredList.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    for (const [name, property] of Object.entries(properties)) {
      if (!safeKey(name) || property === null || typeof property !== 'object')
        continue;
      const type: unknown = Reflect.get(property, 'type');
      if (type === 'object') {
        visit(property, [...path, name], depth + 1);
        continue;
      }
      if (type !== 'string' && type !== 'number' && type !== 'integer')
        continue;
      const hint: MutableHint = { required: required.has(name) };
      if (type === 'string') {
        const minLength = count(Reflect.get(property, 'minLength'));
        const maxLength = count(Reflect.get(property, 'maxLength'));
        if (minLength !== undefined && minLength > 0)
          hint.minLength = minLength;
        if (maxLength !== undefined) hint.maxLength = maxLength;
        const format: unknown = Reflect.get(property, 'format');
        if (format === 'email') hint.type = 'email';
        else if (format === 'uri' || format === 'url') hint.type = 'url';
        else if (options.patterns !== false) {
          const pattern: unknown = Reflect.get(property, 'pattern');
          const converted =
            typeof pattern === 'string' ? htmlPattern(pattern) : undefined;
          if (converted !== undefined) hint.pattern = converted;
        }
      } else {
        hint.type = 'number';
        const min = finite(Reflect.get(property, 'minimum'));
        const max = finite(Reflect.get(property, 'maximum'));
        const step = finite(Reflect.get(property, 'multipleOf'));
        if (min !== undefined) hint.min = min;
        if (max !== undefined) hint.max = max;
        if (step !== undefined && step > 0) hint.step = step;
        else if (type === 'integer') hint.step = 1;
      }
      hints[formatPath([...path, name])] = freezeHint(hint);
    }
  };
  visit(schema, [], 0);
  return Object.freeze(hints);
}

/** Structural view of a Zod 4 schema's JSON Schema export. */
export interface JsonSchemaSource {
  toJSONSchema(options?: Readonly<Record<string, unknown>>): unknown;
}
/**
 * Hints from a Zod 4 object schema through its own `toJSONSchema()` (input
 * shape, unrepresentable parts ignored). Zod is never imported here. Zod's
 * JSON Schema drops regex flags (`/x/i` becomes `x`), which would make the
 * browser stricter than the server, so patterns are opt-in: pass
 * `patterns: true` only when no `.regex()` in the schema uses flags.
 */
export function zodHints(
  schema: JsonSchemaSource,
  options: { readonly patterns?: boolean } = {},
): FormHints {
  if (!schema || typeof schema.toJSONSchema !== 'function')
    throw new Error('zodHints requires a Zod 4 schema with toJSONSchema()');
  return hintsFromJsonSchema(
    schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
    { patterns: options.patterns === true },
  );
}

interface ValidationMetadataLike {
  readonly propertyName: string;
  readonly type: string;
  readonly name?: string;
  readonly constraints?: readonly unknown[];
}
interface MetadataStorageLike {
  getTargetValidationMetadatas(
    target: new () => object,
    schema: string,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): readonly ValidationMetadataLike[];
}
/**
 * Hints from class-validator decorators (`IsOptional`, `IsNotEmpty`,
 * `MinLength`, `MaxLength`, `Length`, `Min`, `Max`, `IsInt`, `IsNumber`,
 * `IsEmail`, `IsUrl`, `Matches`). Properties without `@IsOptional()` are
 * required. Loads the optional peer on first use.
 */
export async function classValidatorHints(
  dto: new () => object,
  options: {
    readonly groups?: readonly string[];
    readonly strictGroups?: boolean;
  } = {},
): Promise<FormHints> {
  if (typeof dto !== 'function')
    throw new Error('classValidatorHints requires a DTO class');
  let storage: MetadataStorageLike;
  try {
    const validator = await import('class-validator');
    storage = validator.getMetadataStorage() as unknown as MetadataStorageLike;
  } catch (error) {
    throw new Error(
      'classValidatorHints requires the optional peer dependency class-validator',
      { cause: error },
    );
  }
  const metadata = storage.getTargetValidationMetadatas(
    dto,
    '',
    // Same selection as validate(): ungrouped rules only without groups.
    false,
    options.groups === undefined ? false : (options.strictGroups ?? true),
    options.groups === undefined ? undefined : [...options.groups],
  );
  const byField = new Map<string, MutableHint & { optional: boolean }>();
  for (const entry of metadata) {
    if (!safeKey(entry.propertyName)) continue;
    const hint = byField.get(entry.propertyName) ?? {
      required: true,
      optional: false,
    };
    byField.set(entry.propertyName, hint);
    const [first, second] = entry.constraints ?? [];
    switch (entry.name) {
      case 'isOptional':
        hint.optional = true;
        break;
      case 'minLength': {
        const value = count(first);
        if (value !== undefined && value > 0) hint.minLength = value;
        break;
      }
      case 'maxLength': {
        const value = count(first);
        if (value !== undefined) hint.maxLength = value;
        break;
      }
      case 'isLength': {
        const min = count(first);
        const max = count(second);
        if (min !== undefined && min > 0) hint.minLength = min;
        if (max !== undefined) hint.maxLength = max;
        break;
      }
      case 'min':
      case 'max': {
        const value = finite(first);
        if (value !== undefined) hint[entry.name] = value;
        hint.type ??= 'number';
        break;
      }
      case 'isInt':
        hint.type = 'number';
        hint.step = 1;
        break;
      case 'isNumber':
        hint.type = 'number';
        break;
      case 'isEmail':
        hint.type = 'email';
        break;
      case 'isUrl':
        hint.type = 'url';
        break;
      case 'matches':
        if (first instanceof RegExp) {
          const pattern = htmlPattern(first.source, first.flags);
          if (pattern !== undefined) hint.pattern = pattern;
        }
        break;
      default:
        break;
    }
  }
  const hints: Record<string, FieldHint> = {};
  for (const [field, { optional, ...hint }] of byField)
    hints[field] = freezeHint({ ...hint, required: !optional });
  return Object.freeze(hints);
}

/** HTML attributes for one control, values as strings (`required` is `''`). */
export function hintAttributes(
  hint: FieldHint | undefined,
): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  if (!hint) return Object.freeze(attributes);
  if (hint.required) attributes['required'] = '';
  if (hint.type) attributes['type'] = hint.type;
  if (hint.minLength !== undefined)
    attributes['minlength'] = String(hint.minLength);
  if (hint.maxLength !== undefined)
    attributes['maxlength'] = String(hint.maxLength);
  if (hint.min !== undefined) attributes['min'] = String(hint.min);
  if (hint.max !== undefined) attributes['max'] = String(hint.max);
  if (hint.step !== undefined) attributes['step'] = String(hint.step);
  if (hint.pattern !== undefined) attributes['pattern'] = hint.pattern;
  return Object.freeze(attributes);
}
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
/**
 * The same attributes as escaped markup (` required minlength="2"`), for a
 * trusted template helper such as
 * `hintAttrs: (field) => SafeHtml.trusted(hintAttributeString(hints[field]))`.
 */
export function hintAttributeString(hint: FieldHint | undefined): string {
  return Object.entries(hintAttributes(hint))
    .map(([name, value]) =>
      value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`,
    )
    .join('');
}
