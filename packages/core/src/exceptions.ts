import {
  Catch,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  ExceptionFilter,
  LoggerService,
} from '@nestjs/common';
import { RequestContextFactory } from './context.js';
import { DiagnosticsRegistry } from './diagnostics.js';
import { createRedactor } from './redaction.js';
import type { RedactionOptions } from './redaction.js';

export const NESTVEXA_ERROR_LOGGER = Symbol('NESTVEXA_ERROR_LOGGER');
export const NESTVEXA_ERROR_REDACTION = Symbol('NESTVEXA_ERROR_REDACTION');

/** Standard error envelope: the original HTTP body plus the request correlation ID. */
export interface NestvexaErrorBody {
  readonly statusCode: number;
  readonly code?: string;
  readonly message?: unknown;
  readonly correlationId: string;
  readonly [key: string]: unknown;
}

function send(
  response: object,
  status: number,
  correlationId: string,
  body: NestvexaErrorBody,
): void {
  // Structural Express/Fastify reply so core needs no @nestjs/core adapter.
  const code: unknown = Reflect.get(response, 'code');
  const statusMethod: unknown = Reflect.get(response, 'status');
  if (
    typeof code === 'function' &&
    typeof Reflect.get(response, 'send') === 'function'
  ) {
    const reply: unknown = Reflect.apply(code, response, [status]);
    const target =
      typeof reply === 'object' && reply !== null ? reply : response;
    Reflect.apply(
      Reflect.get(target, 'header') as (...args: unknown[]) => unknown,
      target,
      ['x-request-id', correlationId],
    );
    Reflect.apply(
      Reflect.get(target, 'send') as (...args: unknown[]) => unknown,
      target,
      [body],
    );
    return;
  }
  if (typeof statusMethod === 'function') {
    const setHeader: unknown = Reflect.get(response, 'setHeader');
    if (typeof setHeader === 'function')
      Reflect.apply(setHeader, response, ['x-request-id', correlationId]);
    const reply: unknown = Reflect.apply(statusMethod, response, [status]);
    const target =
      typeof reply === 'object' && reply !== null ? reply : response;
    Reflect.apply(
      Reflect.get(target, 'json') as (...args: unknown[]) => unknown,
      target,
      [body],
    );
    return;
  }
  throw new TypeError('Unsupported HTTP response object');
}

/**
 * Global exception filter for the standard envelope (CORE-035). HTTP
 * exceptions keep their body (Live `{ statusCode, code }`, validation
 * messages) and gain `correlationId`; anything else becomes
 * `500 { code: 'INTERNAL_ERROR', message: 'Internal server error' }` with no
 * message, stack or path. Every response carries `x-request-id`. Server errors
 * are logged once through a redacting logger with the correlation ID and a
 * `nestvexa.error` diagnostic event. Register with
 * `app.useGlobalFilters(app.get(NestvexaExceptionFilter))`.
 */
@Catch()
@Injectable()
export class NestvexaExceptionFilter implements ExceptionFilter {
  readonly #logger: LoggerService;
  readonly #redactor: ReturnType<typeof createRedactor>;
  constructor(
    @Inject(RequestContextFactory)
    private readonly context: RequestContextFactory,
    @Optional()
    @Inject(DiagnosticsRegistry)
    private readonly diagnostics: DiagnosticsRegistry | null = null,
    @Optional()
    @Inject(NESTVEXA_ERROR_LOGGER)
    logger: LoggerService | null = null,
    @Optional()
    @Inject(NESTVEXA_ERROR_REDACTION)
    redaction: RedactionOptions | null = null,
  ) {
    this.#logger = logger ?? new Logger('Nestvexa');
    this.#redactor = createRedactor(redaction ?? {});
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<object>();
    const correlationId = this.context.correlationId(request);
    let status = 500;
    let body: NestvexaErrorBody;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const original: unknown = exception.getResponse();
      body =
        typeof original === 'object' &&
        original !== null &&
        !Array.isArray(original)
          ? {
              statusCode: status,
              ...(original as Record<string, unknown>),
              correlationId,
            }
          : { statusCode: status, message: String(original), correlationId };
    } else
      body = {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        correlationId,
      };
    if (status >= 500) {
      const error =
        exception instanceof Error
          ? { name: exception.name, message: exception.message }
          : { name: typeof exception };
      try {
        this.#logger.error(
          this.#redactor.value({ correlationId, status, error }),
        );
      } catch {
        // Logging never replaces the response.
      }
    }
    try {
      this.diagnostics?.event('nestvexa.error', {
        status,
        correlationId,
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
      });
    } catch {
      // Diagnostics are best effort.
    }
    send(response, status, correlationId, body);
  }
}
