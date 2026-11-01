import type { InertiaPageObject } from './page.js';

/** Pre-rendered markup returned by an SSR renderer (protocol `head`/`body`). */
export interface InertiaSsrResult {
  /** Elements for the document `<head>`. Trusted markup from the SSR process. */
  readonly head: readonly string[];
  /**
   * Replaces the page script and root `<div>`; must contain both and carry
   * `data-server-rendered="true"`. Trusted markup printed as-is.
   */
  readonly body: string;
}

export interface InertiaSsrContext {
  readonly request: object;
  readonly app: string;
}

/**
 * Server-side rendering contract. Phase 9 supplies framework renderers; this
 * package ships `HttpSsrGateway` for the official Inertia SSR HTTP server.
 */
export interface InertiaSsrRenderer {
  render(
    page: InertiaPageObject,
    pageJson: string,
    context: InertiaSsrContext,
  ): Promise<InertiaSsrResult>;
}

export type InertiaSsrErrorType =
  | 'browser-api'
  | 'component-resolution'
  | 'render'
  | 'connection'
  | 'timeout'
  | 'invalid-response';

/** A failed SSR render. Detail is for server logs only and never sent to clients. */
export class InertiaSsrError extends Error {
  constructor(
    readonly type: InertiaSsrErrorType,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InertiaSsrError';
  }
}

export interface InertiaSsrOptions {
  readonly renderer: InertiaSsrRenderer;
  /**
   * `fallback` (default) logs the failure and serves the client-rendered
   * document; `strict` propagates the failure as a server error.
   */
  readonly mode?: 'fallback' | 'strict';
  /** Observes failures (both modes). Must not throw. */
  readonly onError?: (error: unknown, context: InertiaSsrContext) => void;
}

export interface HttpSsrGatewayOptions {
  /** SSR server base URL. Default `http://127.0.0.1:13714` (upstream default). */
  readonly url?: string;
  /** Per-render timeout. Default 5000 ms. */
  readonly timeoutMs?: number;
  /** Maximum accepted response size. Default 5 MiB. */
  readonly maxResponseBytes?: number;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * Client for the documented Inertia SSR server wire contract: `POST /render`
 * with the page object, `{head, body}` on success, `500` with a classified
 * error body on failure, `GET /health` returning `{"status":"OK"}`.
 * See https://inertiajs.com/docs/v3/core-concepts/the-protocol#server-side-rendering
 */
export class HttpSsrGateway implements InertiaSsrRenderer {
  readonly #base: URL;
  readonly #timeout: number;
  readonly #maxBytes: number;

  constructor(options: HttpSsrGatewayOptions = {}) {
    this.#base = new URL(options.url ?? 'http://127.0.0.1:13714');
    if (this.#base.protocol !== 'http:' && this.#base.protocol !== 'https:')
      throw new TypeError('SSR gateway URL must be http(s)');
    this.#timeout = options.timeoutMs ?? 5000;
    this.#maxBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(new URL('health', this.#endpointBase()), {
        signal: AbortSignal.timeout(this.#timeout),
      });
      const body: unknown = await response.json();
      return (
        response.ok &&
        typeof body === 'object' &&
        body !== null &&
        (body as { status?: unknown }).status === 'OK'
      );
    } catch {
      return false;
    }
  }

  async render(
    _page: InertiaPageObject,
    pageJson: string,
  ): Promise<InertiaSsrResult> {
    let response: Response;
    try {
      response = await fetch(new URL('render', this.#endpointBase()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pageJson,
        signal: AbortSignal.timeout(this.#timeout),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut =
        error instanceof DOMException && error.name === 'TimeoutError';
      throw new InertiaSsrError(
        timedOut ? 'timeout' : 'connection',
        timedOut ? 'SSR render timed out' : 'SSR server unreachable',
        {},
        { cause: error },
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > this.#maxBytes)
      throw new InertiaSsrError('invalid-response', 'SSR response too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new InertiaSsrError(
        'invalid-response',
        'SSR response is not JSON',
        {},
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const type = detail['type'];
      throw new InertiaSsrError(
        type === 'browser-api' ||
          type === 'component-resolution' ||
          type === 'render'
          ? type
          : 'render',
        typeof detail['error'] === 'string'
          ? detail['error']
          : `SSR render failed (${response.status})`,
        detail,
      );
    }
    const result = body as { head?: unknown; body?: unknown };
    if (
      typeof body !== 'object' ||
      body === null ||
      !isStringArray(result.head) ||
      typeof result.body !== 'string'
    )
      throw new InertiaSsrError(
        'invalid-response',
        'SSR response must contain head[] and body',
      );
    return { head: result.head, body: result.body };
  }

  #endpointBase(): URL {
    const base = new URL(this.#base.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return base;
  }
}
