import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { INERTIA_OPTIONS } from './constants.js';
import type { ResolvedErrorPage, ResolvedOptions } from './options.js';
import { plainHeader } from './request.js';
import { InertiaService } from './service.js';
import {
  InertiaValidationException,
  InertiaValidationFilter,
} from './validation.js';

/** Fixed, non-revealing messages used whenever debug details are off. */
const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  419: 'Page Expired',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

/** The HTTP status an exception maps to: its own for `HttpException`, else 500. */
export function errorPageStatus(exception: unknown): number {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (Number.isInteger(status) && status >= 400 && status <= 599)
      return status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? (status >= 500 ? 'Server Error' : 'Error');
}

function exceptionMessage(exception: unknown, status: number): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join(', ');
  }
  if (exception instanceof Error && exception.message) return exception.message;
  return statusText(status);
}

/** Document visits (browsers send `text/html`) and Inertia visits get a page. */
function wantsPage(inertia: InertiaService, request: object): boolean {
  if (inertia.isPrecognitive(request)) return false;
  if (plainHeader(request, 'x-inertia') === 'true') return true;
  return /\btext\/html\b/i.test(plainHeader(request, 'accept') ?? '');
}

function headersSent(response: object): boolean {
  const raw = (response as { raw?: unknown }).raw;
  const target = typeof raw === 'object' && raw !== null ? raw : response;
  return (target as { headersSent?: unknown }).headersSent === true;
}

/**
 * Renders the configured `errorPage.component` as a real Inertia page (HTML
 * document for full visits, JSON page for Inertia visits, so the official
 * client swaps in the component) with the original status for the statuses
 * in `errorPage.statuses` (default 403, 404, 500, 503). Props are
 * `{ status, message }`; with `debug` the message is the exception's own and
 * an `exception: { name, message, stack }` prop is added, otherwise the
 * message is the fixed status text and no exception detail leaves the server.
 *
 * Everything else (other statuses, API clients that do not accept HTML,
 * Precognition requests, responses already sent, or no `errorPage` option) is
 * passed to Nest's default exception handling unchanged.
 * `InertiaValidationException` is handed to `InertiaValidationFilter`, so the
 * validation redirect keeps working whichever global filter Nest selects. If
 * rendering the page itself fails (for example a throwing `share` resolver),
 * the original status is answered with a plain-text status line. HTTP only.
 */
@Catch()
export class InertiaErrorPageFilter extends BaseExceptionFilter {
  readonly #logger = new Logger('InertiaErrorPage');
  readonly #inertia: InertiaService;
  readonly #config: ResolvedErrorPage | undefined;
  readonly #validation: InertiaValidationFilter;

  constructor(
    @Inject(InertiaService) inertia: InertiaService,
    @Inject(INERTIA_OPTIONS) options: ResolvedOptions,
    @Inject(InertiaValidationFilter) validation: InertiaValidationFilter,
    @Optional() @Inject(HttpAdapterHost) adapterHost?: HttpAdapterHost,
  ) {
    super(adapterHost?.httpAdapter);
    this.#inertia = inertia;
    this.#config = options.errorPage;
    this.#validation = validation;
  }

  override async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    if (host.getType() !== 'http') throw exception;
    if (exception instanceof InertiaValidationException) {
      await this.#validation.catch(exception, host);
      return;
    }
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<object>();
    const config = this.#config;
    const status = errorPageStatus(exception);
    if (
      config === undefined ||
      !config.statuses.has(status) ||
      headersSent(response) ||
      !wantsPage(this.#inertia, request)
    ) {
      super.catch(exception, host);
      return;
    }
    if (!(exception instanceof HttpException))
      this.#logger.error(
        exception instanceof Error ? exception.message : 'Unhandled exception',
        exception instanceof Error ? exception.stack : undefined,
      );
    try {
      const props = await this.#props(config, status, exception, request);
      await this.#inertia.render(request, response, config.component, props, {
        status,
        ...(config.app === undefined ? {} : { app: config.app }),
      });
    } catch (renderError) {
      this.#logger.error(
        `Rendering the ${String(status)} error page failed`,
        renderError instanceof Error ? renderError.stack : undefined,
      );
      if (headersSent(response)) return;
      this.#inertia.write(response, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: statusText(status),
      });
    }
  }

  async #props(
    config: ResolvedErrorPage,
    status: number,
    exception: unknown,
    request: object,
  ): Promise<Record<string, unknown>> {
    const debug = config.debug;
    const props: Record<string, unknown> = {
      status,
      message: debug ? exceptionMessage(exception, status) : statusText(status),
    };
    if (debug)
      props['exception'] = {
        name: exception instanceof Error ? exception.name : typeof exception,
        message: exceptionMessage(exception, status),
        stack: exception instanceof Error ? (exception.stack ?? null) : null,
      };
    if (!config.props) return props;
    // Spread (define, not assign): a `__proto__` key stays an own property.
    return {
      ...props,
      ...(await config.props({ status, exception, request, debug })),
    };
  }
}
