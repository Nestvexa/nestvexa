import { escapeHtml } from './helpers.js';
import { ViewError, type ViewModel } from './index.js';

/**
 * View-rendered error pages. Production pages render configured templates with
 * a fixed public model; the development page is built-in (the template engine
 * may be what failed) and shows the error chain with the failing template and
 * line. Nothing here imports Nest: the filter is structural.
 */
export interface ErrorPageOptions {
  /** Renders a production error view, for example `(view, model) => engine.render(view, model)`. */
  readonly render?: (view: string, model: ViewModel) => Promise<string>;
  /**
   * Error views by exact status (`'404'`), class (`'4xx'`, `'5xx'`) or
   * `'default'`, searched in that order. Unmapped statuses get a minimal page.
   */
  readonly views?: Readonly<Record<string, string>>;
  /** Detailed diagnostics (messages, template name/line, stacks). Never in production. */
  readonly development?: boolean;
}
export interface ErrorPage {
  readonly status: number;
  readonly html: string;
}
/** Where a `ViewError` says it failed: `Unable to render view: x (partials/a.hbs:3)`. */
export interface TemplateLocation {
  readonly template: string;
  readonly line: number | undefined;
}

const statusText: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

/** HTTP status of an exception: a Nest `HttpException`-like `getStatus()`, else 500. */
export function errorStatus(error: unknown): number {
  if (error !== null && typeof error === 'object') {
    const getStatus: unknown = Reflect.get(error, 'getStatus');
    if (typeof getStatus === 'function') {
      const status: unknown = Reflect.apply(getStatus, error, []);
      if (
        typeof status === 'number' &&
        Number.isSafeInteger(status) &&
        status >= 400 &&
        status <= 599
      )
        return status;
    }
  }
  return 500;
}
function title(status: number): string {
  return (
    statusText[status] ?? (status < 500 ? 'Request Error' : 'Server Error')
  );
}
/** Public 4xx message of a Nest `HttpException`-like error (Nest treats these as public). */
function publicMessage(error: unknown, status: number): string | undefined {
  if (status >= 500 || error === null || typeof error !== 'object')
    return undefined;
  const getResponse: unknown = Reflect.get(error, 'getResponse');
  if (typeof getResponse !== 'function') return undefined;
  const response: unknown = Reflect.apply(getResponse, error, []);
  const message: unknown =
    typeof response === 'string'
      ? response
      : response !== null && typeof response === 'object'
        ? Reflect.get(response, 'message')
        : undefined;
  return typeof message === 'string' && message
    ? message.slice(0, 500)
    : undefined;
}

/** Template name and line from a development `ViewError` message, if present. */
export function templateLocation(error: unknown): TemplateLocation | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current instanceof ViewError) {
      const match = /\(([^()\n]+?)(?::(\d+))?\)$/.exec(current.message);
      if (match?.[1])
        return {
          template: match[1],
          line: match[2] === undefined ? undefined : Number(match[2]),
        };
    }
    current = current.cause;
  }
  return undefined;
}

function shell(status: number, heading: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="robots" content="noindex"><title>${status} ${escapeHtml(heading)}</title>` +
    '<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2328}' +
    'pre{white-space:pre-wrap;background:#f6f8fa;padding:1rem;overflow:auto}' +
    'mark{background:#fff3b0}</style></head>' +
    `<body><main><h1>${status} ${escapeHtml(heading)}</h1>${body}</main></body></html>`
  );
}
function developmentPage(error: unknown, status: number): string {
  const parts: string[] = [];
  const location = templateLocation(error);
  if (location)
    parts.push(
      `<p>Template <mark data-nv-template>${escapeHtml(location.template)}</mark>` +
        (location.line === undefined
          ? ''
          : ` line <mark data-nv-line>${location.line}</mark>`) +
        '</p>',
    );
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(
        `<section><h2>${escapeHtml(current.name)}</h2><p>${escapeHtml(current.message)}</p>` +
          (current.stack
            ? `<pre>${escapeHtml(current.stack.slice(0, 20_000))}</pre>`
            : '') +
          '</section>',
      );
      current = current.cause;
    } else {
      parts.push(
        `<section><h2>Thrown value</h2><pre>${escapeHtml(String(current).slice(0, 2000))}</pre></section>`,
      );
      break;
    }
  }
  parts.push(
    '<p><small>Development error page. Disable <code>development</code> in production.</small></p>',
  );
  return shell(status, title(status), parts.join(''));
}

/**
 * Builds the error response body. Development: the diagnostic page. Production:
 * the configured view with `{ status, title, message? }` (`message` only for
 * public 4xx messages), or a minimal page when no view is configured or the
 * error view itself fails to render.
 */
export async function renderErrorPage(
  error: unknown,
  options: ErrorPageOptions = {},
): Promise<ErrorPage> {
  const status = errorStatus(error);
  if (options.development === true)
    return { status, html: developmentPage(error, status) };
  const views = options.views ?? {};
  const keys = [String(status), `${String(status).charAt(0)}xx`, 'default'];
  const view = keys
    .map((key) => (Object.hasOwn(views, key) ? views[key] : undefined))
    .find((candidate): candidate is string => typeof candidate === 'string');
  const message = publicMessage(error, status);
  if (view !== undefined && options.render)
    try {
      return {
        status,
        html: await options.render(view, {
          status,
          title: title(status),
          ...(message === undefined ? {} : { message }),
        }),
      };
    } catch {
      // Fall through: an error page must not fail with another error.
    }
  return {
    status,
    html: shell(
      status,
      title(status),
      message === undefined ? '' : `<p>${escapeHtml(message)}</p>`,
    ),
  };
}

/** Structural subset of Nest's `ArgumentsHost`. */
export interface ErrorPageHost {
  getType?(): string;
  switchToHttp(): { getRequest(): unknown; getResponse(): unknown };
}
export interface ViewErrorPageFilterOptions extends ErrorPageOptions {
  /**
   * Whether a request gets an HTML page. Default: its `Accept` header names
   * `text/html`. Other requests (JSON APIs, Live and action calls) receive
   * Nest's default JSON error body.
   */
  readonly html?: (request: unknown) => boolean;
  /** Called for 5xx errors. Default `console.error`. */
  readonly log?: (error: unknown, status: number) => void;
}
function header(request: unknown, name: string): string {
  if (request === null || typeof request !== 'object') return '';
  const headers: unknown = Reflect.get(request, 'headers');
  if (headers === null || typeof headers !== 'object') return '';
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : '';
}
function jsonBody(error: unknown, status: number): unknown {
  if (error !== null && typeof error === 'object' && status < 500) {
    const getResponse: unknown = Reflect.get(error, 'getResponse');
    if (typeof getResponse === 'function') {
      const response: unknown = Reflect.apply(getResponse, error, []);
      return typeof response === 'string'
        ? { statusCode: status, message: response }
        : response;
    }
  }
  return status >= 500
    ? { statusCode: status, message: 'Internal server error' }
    : { statusCode: status, message: title(status) };
}
/** Writes to an Express response or a Fastify reply. */
function send(
  response: unknown,
  status: number,
  type: string,
  body: string,
): void {
  if (response === null || typeof response !== 'object') return;
  const call = (name: string, ...args: unknown[]): unknown => {
    const fn: unknown = Reflect.get(response, name);
    return typeof fn === 'function'
      ? Reflect.apply(fn, response, args)
      : undefined;
  };
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (typeof Reflect.get(response, 'code') === 'function') {
    if (Reflect.get(response, 'sent') === true) return;
    call('code', status);
    for (const [name, value] of Object.entries(headers))
      call('header', name, value);
    call('send', body);
    return;
  }
  if (Reflect.get(response, 'headersSent') === true) {
    call('end');
    return;
  }
  call('status', status);
  for (const [name, value] of Object.entries(headers))
    call('setHeader', name, value);
  call('end', body);
}

/**
 * Catch-all Nest exception filter (`app.useGlobalFilters(new ViewErrorPageFilter(...))`)
 * rendering error views for browser page requests and keeping Nest's JSON body
 * for everything else.
 */
export class ViewErrorPageFilter {
  readonly #options: ViewErrorPageFilterOptions;
  constructor(options: ViewErrorPageFilterOptions = {}) {
    this.#options = Object.freeze({ ...options });
  }
  async catch(exception: unknown, host: ErrorPageHost): Promise<void> {
    if (typeof host.getType === 'function' && host.getType() !== 'http')
      throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const status = errorStatus(exception);
    if (status >= 500)
      (this.#options.log ?? ((error: unknown) => console.error(error)))(
        exception,
        status,
      );
    const wantsHtml = this.#options.html
      ? this.#options.html(request) === true
      : /\btext\/html\b/i.test(header(request, 'accept'));
    if (!wantsHtml) {
      send(
        response,
        status,
        'application/json; charset=utf-8',
        JSON.stringify(jsonBody(exception, status)),
      );
      return;
    }
    const page = await renderErrorPage(exception, this.#options);
    send(response, page.status, 'text/html; charset=utf-8', page.html);
  }
}
