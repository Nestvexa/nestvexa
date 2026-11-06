import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { validateForm } from './adapter.js';
import type { SchemaAdapter } from './adapter.js';
import { FORM_ERROR, FormInputError, parsePath } from './errors.js';
import type { FormErrors, PathSegment } from './errors.js';
import type { InputLimits } from './harden.js';

/** Issue shape shared with `@nestvexa/actions` (structural; no dependency). */
export interface FormSchemaIssue {
  readonly path: readonly PathSegment[];
  readonly message: string;
}
/**
 * `safeParseAsync`-compatible view of a schema adapter, accepted wherever a
 * Zod-like schema is, notably `@ServerAction({ input })` in
 * `@nestvexa/actions`. Neither package imports the other.
 */
export interface FormActionSchema<T> {
  safeParseAsync(value: unknown): Promise<
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly FormSchemaIssue[] };
      }
  >;
}

function issues(errors: FormErrors): FormSchemaIssue[] {
  const list: FormSchemaIssue[] = [];
  for (const [path, messages] of Object.entries(errors)) {
    let segments: PathSegment[] = [];
    if (path !== FORM_ERROR)
      try {
        segments = parsePath(path);
      } catch {
        segments = [];
      }
    for (const message of messages) list.push({ path: segments, message });
  }
  return list;
}
async function run<T>(
  adapter: SchemaAdapter<T>,
  value: unknown,
  limits: InputLimits | undefined,
): Promise<{ ok: true; value: T } | { ok: false; errors: FormErrors }> {
  try {
    return await validateForm(
      adapter,
      value,
      limits === undefined ? {} : { limits },
    );
  } catch (error) {
    // Hardening violations are client errors, reported without echoing values.
    if (error instanceof FormInputError)
      return {
        ok: false,
        errors: {
          [error.path || FORM_ERROR]: [
            'The submitted values could not be read.',
          ],
        },
      };
    throw error;
  }
}

/**
 * Expose a forms adapter as an actions input schema:
 * `@ServerAction({ input: actionSchema(profileAdapter) })` plus an
 * `@ActionInput()` parameter. Validation issues keep their field paths.
 */
export function actionSchema<T>(
  adapter: SchemaAdapter<T>,
  options: { readonly limits?: InputLimits } = {},
): FormActionSchema<T> {
  if (!adapter || typeof adapter.validate !== 'function')
    throw new Error('actionSchema requires a schema adapter');
  return Object.freeze({
    async safeParseAsync(value: unknown) {
      const result = await run(adapter, value, options.limits);
      return result.ok
        ? { success: true as const, data: result.value }
        : {
            success: false as const,
            error: { issues: issues(result.errors) },
          };
    },
  });
}

/**
 * Nest pipe validating a body (or `@ActionInput(new FormValidationPipe(a))`)
 * with a forms adapter. Failures throw `BadRequestException` with
 * `{ message: string[], errors: FormErrors }`; the typed value is returned.
 */
export class FormValidationPipe<T> implements PipeTransform<
  unknown,
  Promise<T>
> {
  readonly #adapter: SchemaAdapter<T>;
  readonly #limits: InputLimits | undefined;
  constructor(
    adapter: SchemaAdapter<T>,
    options: { readonly limits?: InputLimits } = {},
  ) {
    if (!adapter || typeof adapter.validate !== 'function')
      throw new Error('FormValidationPipe requires a schema adapter');
    this.#adapter = adapter;
    this.#limits = options.limits;
  }
  async transform(value: unknown): Promise<T> {
    const result = await run(this.#adapter, value, this.#limits);
    if (result.ok) return result.value;
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: Object.values(result.errors).flat().slice(0, 50),
      errors: result.errors,
    });
  }
}
