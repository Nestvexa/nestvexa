import { failure } from './adapter.js';
import type {
  AdapterOptions,
  SchemaAdapter,
  ValidationIssue,
  ValidationResult,
} from './adapter.js';
import { formatPath } from './errors.js';
import type { PathSegment } from './errors.js';
import { hardenInput } from './harden.js';

/** Options for {@link classValidatorAdapter}. Defaults are the secure choice. */
export interface ClassValidatorAdapterOptions extends AdapterOptions {
  /** class-validator groups to run. */
  readonly groups?: readonly string[];
  /** With groups, ignore decorators that declare no group. Default true when groups are given. */
  readonly strictGroups?: boolean;
  /** Strip properties without decorators. Default true. */
  readonly whitelist?: boolean;
  /** Report undecorated properties as errors instead of stripping. Default true. */
  readonly forbidNonWhitelisted?: boolean;
  /** Reject objects without any known metadata. Default true. */
  readonly forbidUnknownValues?: boolean;
  /** Partial validation: skip `undefined`/`null` properties. Default false. */
  readonly skipMissingProperties?: boolean;
}

interface ValidationErrorLike {
  readonly property: string;
  readonly constraints?: Readonly<Record<string, string>>;
  readonly children?: readonly ValidationErrorLike[];
}
interface Libraries {
  readonly validate: (
    object: object,
    options: Record<string, unknown>,
  ) => Promise<readonly ValidationErrorLike[]>;
  readonly plainToInstance: <T>(
    type: new () => T,
    plain: object,
    options: Record<string, unknown>,
  ) => T;
}

let libraries: Promise<Libraries> | undefined;
/** Load the optional peers once, only when a class-validator adapter validates. */
function load(): Promise<Libraries> {
  libraries ??= Promise.all([
    import('class-validator'),
    import('class-transformer'),
  ]).then(
    ([validator, transformer]) => ({
      validate: (object, options) => validator.validate(object, options),
      plainToInstance: <T>(
        type: new () => T,
        plain: object,
        options: Record<string, unknown>,
      ): T => transformer.plainToInstance(type, plain, options),
    }),
    (error: unknown) => {
      libraries = undefined;
      throw new Error(
        'classValidatorAdapter requires the optional peer dependencies class-validator and class-transformer',
        { cause: error },
      );
    },
  );
  return libraries;
}

function flatten(
  errors: readonly ValidationErrorLike[],
  parent: readonly PathSegment[],
  issues: ValidationIssue[],
  depth = 0,
): void {
  if (depth > 16) return;
  for (const error of errors) {
    if (issues.length >= 200) return;
    const segment: PathSegment = /^(?:0|[1-9][0-9]{0,8})$/.test(error.property)
      ? Number(error.property)
      : error.property;
    const path = [...parent, segment];
    for (const [code, message] of Object.entries(error.constraints ?? {}))
      issues.push({ path: formatPath(path), code, message });
    if (error.children?.length)
      flatten(error.children, path, issues, depth + 1);
  }
}

/**
 * Class fields compiled with define semantics (`useDefineForClassFields`, the
 * ES2022 default) create own `undefined` properties for every declared field.
 * Hardened input never contains `undefined`, so such properties were not
 * submitted; removing them keeps whitelisting (especially with groups) about
 * submitted data only.
 */
function pruneUndefined(value: unknown, depth = 0): void {
  if (depth > 16 || value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    if (descriptor.value === undefined && !Array.isArray(value))
      Reflect.deleteProperty(value, key);
    else pruneUndefined(descriptor.value, depth + 1);
  }
}

/**
 * Adapt a class-validator DTO. Input is hardened, transformed with
 * class-transformer `plainToInstance` (`enableImplicitConversion: false`, so
 * `"1"` never silently becomes `1`) and validated with whitelisting,
 * non-whitelisted rejection and unknown-value rejection on by default. Nested
 * DTOs need `@ValidateNested()` and `@Type(() => Child)`; their paths become
 * `items.0.name`. Constraint names (`isEmail`, `minLength`, `whitelistValidation`)
 * are the localization keys. Transform failures become a form-level `transform` issue.
 */
export function classValidatorAdapter<T extends object>(
  dto: new () => T,
  options: ClassValidatorAdapterOptions = {},
): SchemaAdapter<T> {
  if (typeof dto !== 'function')
    throw new Error('classValidatorAdapter requires a DTO class');
  if (
    options.groups !== undefined &&
    (!Array.isArray(options.groups) ||
      options.groups.some((group) => typeof group !== 'string' || !group))
  )
    throw new Error('Validation groups must be non-empty strings');
  const settings: Record<string, unknown> = {
    whitelist: options.whitelist ?? true,
    forbidNonWhitelisted: options.forbidNonWhitelisted ?? true,
    forbidUnknownValues: options.forbidUnknownValues ?? true,
    skipMissingProperties: options.skipMissingProperties ?? false,
    validationError: { target: false, value: false },
    ...(options.groups === undefined
      ? {}
      : {
          groups: [...options.groups],
          strictGroups: options.strictGroups ?? true,
        }),
  };
  return Object.freeze({
    async validate(input: unknown): Promise<ValidationResult<T>> {
      const hardened = hardenInput(input, options.limits);
      if (
        hardened === null ||
        typeof hardened !== 'object' ||
        Array.isArray(hardened)
      )
        return failure(
          [{ path: '', code: 'type', message: 'Expected form fields.' }],
          options.messages,
        );
      const { validate, plainToInstance } = await load();
      let instance: T;
      try {
        instance = plainToInstance(dto, hardened, {
          enableImplicitConversion: false,
          excludeExtraneousValues: false,
          exposeUnsetFields: false,
        });
      } catch {
        return failure(
          [
            {
              path: '',
              code: 'transform',
              message: 'The submitted values could not be read.',
            },
          ],
          options.messages,
        );
      }
      pruneUndefined(instance);
      if (!(instance instanceof dto))
        return failure(
          [{ path: '', code: 'type', message: 'Expected form fields.' }],
          options.messages,
        );
      const errors = await validate(instance, settings);
      if (!errors.length)
        return Object.freeze({ ok: true as const, value: instance });
      const issues: ValidationIssue[] = [];
      flatten(errors, [], issues);
      return failure(issues, options.messages);
    },
  });
}
