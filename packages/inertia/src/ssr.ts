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
 * Reads a response body as UTF-8 text, cancelling the stream as soon as it
 * exceeds `maxBytes` so a faulty or hostile SSR endpoint cannot make the host
 * buffer an unbounded body. Returns `undefined` when the limit is exceeded.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
    if (
      this.#base.username ||
      this.#base.password ||
      this.#base.search ||
      this.#base.hash
    )
      throw new TypeError(
        'SSR gateway URL must not contain credentials, a query or a fragment',
      );
    this.#timeout = options.timeoutMs ?? 5000;
    this.#maxBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  }

  async health(): Promise<boolean> {
    try {
      // Like render(): never follow a redirect away from the configured server.
      const response = await fetch(new URL('health', this.#endpointBase()), {
        signal: AbortSignal.timeout(this.#timeout),
        redirect: 'error',
      });
      const text = await readBounded(response, 4096);
      if (text === undefined) return false;
      const body: unknown = JSON.parse(text);
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
    let text: string | undefined;
    try {
      text = await readBounded(response, this.#maxBytes);
    } catch (error) {
      const timedOut =
        error instanceof DOMException && error.name === 'TimeoutError';
      throw new InertiaSsrError(
        timedOut ? 'timeout' : 'connection',
        timedOut ? 'SSR render timed out' : 'SSR response interrupted',
        {},
        { cause: error },
      );
    }
    if (text === undefined)
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
