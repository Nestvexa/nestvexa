import { Catch, HttpStatus, Inject, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { InertiaConfigurationError } from './errors.js';
import { InertiaService } from './service.js';
import { assertBagName, normalizeErrors } from './validation-types.js';
import type { InertiaErrors } from './validation-types.js';

export interface InertiaValidationOptions {
  /** Named error bag (otherwise `default`, displayed per `X-Inertia-Error-Bag`). */
  readonly bag?: string;
  /** Relative fallback when the Referer is missing or unsafe. */
  readonly fallback?: string;
}

/**
 * Thrown (or produced by `inertiaValidationExceptionFactory`) when input is
 * invalid. `InertiaValidationFilter` flashes the errors into the host session
 * and redirects back, which is how Inertia expects validation to work: the
 * client never receives a 422 for page visits. Precognition requests get the
 * `422` validation-only reply instead.
 */
export class InertiaValidationException extends Error {
  readonly errors: Readonly<Record<string, readonly string[]>>;
  readonly bag: string;
  readonly fallback: string | undefined;

  constructor(errors: InertiaErrors, options: InertiaValidationOptions = {}) {
    super('Validation failed');
    this.name = 'InertiaValidationException';
    this.errors = Object.freeze(normalizeErrors(errors));
    this.bag =
      options.bag === undefined ? 'default' : assertBagName(options.bag);
    this.fallback = options.fallback;
  }
}

/**
 * Any schema with `validate(input)` resolving to `{ ok: true, value }` or
 * `{ ok: false, errors }`: every `@nestvexa/forms` adapter (`zodAdapter`,
 * `classValidatorAdapter`, `customAdapter`) matches without a dependency.
 */
export interface InertiaValidationSchema<T> {
  validate(
    input: unknown,
  ):
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: InertiaErrors }
    | PromiseLike<
        | { readonly ok: true; readonly value: T }
        | { readonly ok: false; readonly errors: InertiaErrors }
      >;
}

/**
 * Validates a submission with the same schema `@Precognitive(schema)` uses
 * and returns the parsed value, or throws `InertiaValidationException` so
 * `InertiaValidationFilter` flashes the errors (including the
 * `@nestvexa/forms` form-level `_form` key and dotted paths such as
 * `items.0.name`, which the official `useForm` reads as-is) and redirects
 * back. A malformed schema result is a configuration error, never a pass.
 */
export async function inertiaValidate<T>(
  schema: InertiaValidationSchema<T>,
  input: unknown,
  options: InertiaValidationOptions = {},
): Promise<T> {
  const result: unknown = await schema.validate(input);
  if (typeof result === 'object' && result !== null) {
    const { ok } = result as { ok?: unknown };
    if (ok === true && 'value' in result) return (result as { value: T }).value;
    const errors = (result as { errors?: unknown }).errors;
    if (ok === false && typeof errors === 'object' && errors !== null)
      throw new InertiaValidationException(errors as InertiaErrors, options);
  }
  throw new InertiaConfigurationError(
    'Validation schema returned an invalid result',
  );
}

/** Structural subset of class-validator's `ValidationError`. */
export interface ValidationErrorLike {
  readonly property: string;
  readonly constraints?: Readonly<Record<string, string>>;
  readonly children?: readonly ValidationErrorLike[];
}

/** Flattens nested validation errors to dot-path fields. */
export function flattenValidationErrors(
  errors: readonly ValidationErrorLike[],
  prefix = '',
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const error of errors) {
    const field =
      prefix === '' ? error.property : `${prefix}.${error.property}`;
    const messages = Object.values(error.constraints ?? {});
    if (messages.length)
      result[field] = [...(result[field] ?? []), ...messages];
    if (error.children?.length)
      Object.assign(result, flattenValidationErrors(error.children, field));
  }
  return result;
}

/**
 * `exceptionFactory` for Nest's `ValidationPipe`:
 * `new ValidationPipe({ exceptionFactory: inertiaValidationExceptionFactory })`.
 */
export function inertiaValidationExceptionFactory(
  errors: readonly ValidationErrorLike[],
): InertiaValidationException {
  return new InertiaValidationException(flattenValidationErrors(errors));
}

/**
 * Stores validation errors in the host session and redirects back (303 after
 * PUT/PATCH/DELETE). For `Precognition: true` requests it answers the `422`
 * Precognition reply (no session needed). Requires a host session; without one it answers 500 and
 * logs a configuration error instead of silently dropping the errors.
 */
@Catch(InertiaValidationException)
export class InertiaValidationFilter implements ExceptionFilter<InertiaValidationException> {
  readonly #logger = new Logger('InertiaValidationFilter');

  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  async catch(
    exception: InertiaValidationException,
    host: ArgumentsHost,
  ): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<object>();
    // A Precognition client expects the errors themselves, never a redirect.
    if (this.inertia.isPrecognitive(request)) {
      this.inertia.write(
        response,
        this.inertia.precognitionReply(request, exception.errors),
      );
      return;
    }
    if (!this.inertia.hasSession(request)) {
      this.#logger.error('InertiaValidationException requires a host session');
      this.inertia.write(response, {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: 'Internal Server Error',
      });
      return;
    }
    this.inertia.storeErrors(request, exception.errors, exception.bag);
    await this.inertia.respond(
      request,
      response,
      this.inertia.back(
        exception.fallback === undefined
          ? {}
          : { fallback: exception.fallback },
      ),
    );
  }
}
