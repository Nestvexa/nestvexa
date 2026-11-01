import { failure } from './adapter.js';
import type {
  AdapterOptions,
  SchemaAdapter,
  ValidationIssue,
  ValidationResult,
} from './adapter.js';
import { formatPath } from './errors.js';
import { hardenInput } from './harden.js';

/** The part of a Zod issue the adapter reads. */
export interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}
/**
 * Structural view of a Zod 4 schema. `@nestvexa/forms` never imports `zod`: the
 * application's own schema instance (and therefore its Zod copy and locale
 * configuration) is used, and the published declarations do not require Zod.
 */
export interface ZodLikeSchema<T> {
  safeParseAsync(input: unknown): Promise<
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly ZodLikeIssue[] };
      }
  >;
}

/**
 * Adapt a Zod schema. Input is hardened, then parsed with `safeParseAsync`, so
 * async refinements (for example uniqueness checks) are supported. Issue codes
 * (`too_small`, `invalid_format`, `custom`, ...) are the localization keys.
 * Use `z.strictObject` to reject unknown keys; `z.object` strips them.
 */
export function zodAdapter<T>(
  schema: ZodLikeSchema<T>,
  options: AdapterOptions = {},
): SchemaAdapter<T> {
  if (!schema || typeof schema.safeParseAsync !== 'function')
    throw new Error('zodAdapter requires a Zod schema');
  return Object.freeze({
    async validate(input: unknown): Promise<ValidationResult<T>> {
      const hardened = hardenInput(input, options.limits);
      const parsed = await schema.safeParseAsync(hardened);
      if (parsed.success)
        return Object.freeze({ ok: true as const, value: parsed.data });
      const issues: ValidationIssue[] = parsed.error.issues
        .slice(0, 200)
        .map((issue) => ({
          path: formatPath(issue.path),
          code: typeof issue.code === 'string' ? issue.code : 'invalid',
          message:
            typeof issue.message === 'string' && issue.message
              ? issue.message
              : 'Invalid value.',
        }));
      return failure(issues, options.messages);
    },
  });
}
