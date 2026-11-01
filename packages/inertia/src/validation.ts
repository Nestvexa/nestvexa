import { Catch, HttpStatus, Inject, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
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
 * client never receives a 422 for page visits.
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
 * PUT/PATCH/DELETE). Requires a host session; without one it answers 500 and
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
