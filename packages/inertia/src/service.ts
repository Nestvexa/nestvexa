import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  INERTIA_OPTIONS,
  InertiaHeader,
  InertiaSessionKey,
  RESERVED_PROP_KEYS,
} from './constants.js';
import type { InertiaRootContext } from './document.js';
import { InertiaConfigurationError } from './errors.js';
import { traced } from './instrumentation.js';
import type { ResolvedApp, ResolvedOptions } from './options.js';
import type { InertiaPageObject } from './page.js';
import {
  PrecognitionHeader,
  isPrecognitionRequest,
  parsePrecognitionRequest,
  selectPrecognitionErrors,
} from './precognition.js';
import type { PrecognitionRequestInfo } from './precognition.js';
import { always } from './props.js';
import {
  assertSafeRedirect,
  refererPath,
  relativeRequestUrl,
  storablePath,
} from './redirect.js';
import {
  isInertiaRequest,
  parseInertiaRequest,
  plainHeader,
} from './request.js';
import type { InertiaRequestInfo } from './request.js';
import { PropsResolver, isPlainObject } from './resolver.js';
import {
  InertiaBackResult,
  InertiaLocationResult,
  InertiaPageResult,
  InertiaRedirectResult,
} from './results.js';
import type {
  InertiaBackOptions,
  InertiaRedirectOptions,
  InertiaRenderOptions,
  InertiaResult,
} from './results.js';
import { escapeJsonForScript, toJsonValue } from './serialize.js';
import type { JsonValue } from './serialize.js';
import { pull } from './session.js';
import { normalizeErrors, readStoredBags } from './validation-types.js';
import type { InertiaErrors, StoredErrorBags } from './validation-types.js';
import { validComponent } from './text.js';

/** A complete, platform-neutral HTTP reply produced by the adapter. */
export interface InertiaHttpReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface RequestState {
  info?: InertiaRequestInfo;
  precognition?: PrecognitionRequestInfo;
  claimed: boolean;
  shared: Record<string, unknown>;
  flash: Record<string, unknown>;
  clearHistory: boolean;
  encryptHistory: boolean | undefined;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function reservedKey(key: string): boolean {
  const top = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
  return RESERVED_PROP_KEYS.has(top);
}

function assertProps(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value))
    throw new InertiaConfigurationError(`${label} must be a plain object`);
  for (const key of Object.keys(value))
    if (reservedKey(key))
      throw new InertiaConfigurationError(
        `${label} must not define the reserved "${key}" prop; use validation errors instead`,
      );
  return value;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value))
    throw new InertiaConfigurationError(`${label} must be a plain object`);
  return value;
}

/**
 * Inertia v3 server adapter core. Builds protocol replies from handler results
 * and request headers; all per-request data lives in a request-keyed WeakMap or
 * the host session, never on this singleton.
 */
@Injectable()
export class InertiaService {
  readonly #options: ResolvedOptions;
  readonly #host: HttpAdapterHost | undefined;
  readonly #requests = new WeakMap<object, RequestState>();
  readonly #logger = new Logger('Inertia');

  constructor(
    @Inject(INERTIA_OPTIONS) options: ResolvedOptions,
    @Optional() @Inject(HttpAdapterHost) host?: HttpAdapterHost,
  ) {
    this.#options = options;
    this.#host = host;
  }

  #state(request: object): RequestState {
    let state = this.#requests.get(request);
    if (!state) {
      state = {
        claimed: false,
        shared: {},
        flash: {},
        clearHistory: false,
        encryptHistory: undefined,
      };
      this.#requests.set(request, state);
    }
    return state;
  }

  /** @internal Lets exactly one interceptor instance own a request. */
  claim(request: object): boolean {
    const state = this.#state(request);
    if (state.claimed) return false;
    state.claimed = true;
    return true;
  }

  /** Parsed and validated Inertia headers (throws `InertiaRequestError` → 400). */
  requestInfo(request: object): InertiaRequestInfo {
    const state = this.#state(request);
    state.info ??= parseInertiaRequest(request, this.#options.limits);
    return state.info;
  }

  isInertia(request: object): boolean {
    return isInertiaRequest(request);
  }

  /** True for `Precognition: true` requests (validation-only visits). */
  isPrecognitive(request: object): boolean {
    return isPrecognitionRequest(request);
  }

  /** Parsed Precognition headers (throws `InertiaRequestError` → 400 when malformed). */
  precognition(request: object): PrecognitionRequestInfo {
    const state = this.#state(request);
    state.precognition ??= parsePrecognitionRequest(
      request,
      this.#options.limits,
    );
    return state.precognition;
  }

  /**
   * The reply to a Precognition request: `204` with `Precognition-Success:
   * true` when no requested field failed, otherwise `422` with Laravel-shaped
   * `{ message, errors }` (message arrays; the client simplifies them unless
   * `withAllErrors` is on). Both carry `Precognition: true` and
   * `Vary: Precognition`.
   */
  precognitionReply(
    request: object,
    errors: InertiaErrors | undefined,
  ): InertiaHttpReply {
    const { only } = this.precognition(request);
    const failed =
      errors === undefined
        ? {}
        : selectPrecognitionErrors(normalizeErrors(errors), only);
    const messages = Object.values(failed);
    const first = messages[0]?.[0];
    if (first === undefined)
      return {
        status: 204,
        headers: {
          [PrecognitionHeader.precognition]: 'true',
          [PrecognitionHeader.success]: 'true',
          Vary: PrecognitionHeader.precognition,
        },
        body: '',
      };
    const more = messages.reduce((total, list) => total + list.length, 0) - 1;
    // Mirrors ValidationException::summarize in Laravel.
    const message =
      more > 0
        ? `${first} (and ${more} more error${more === 1 ? '' : 's'})`
        : first;
    return {
      status: 422,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        [PrecognitionHeader.precognition]: 'true',
        Vary: PrecognitionHeader.precognition,
      },
      body: JSON.stringify({ message, errors: failed }),
    };
  }

  hasSession(request: object): boolean {
    return this.#options.session?.available(request) === true;
  }

  /** @internal The configured empty-response behaviour (see `emptyResponse`). */
  get emptyResponse(): 'back' | 'passthrough' {
    return this.#options.emptyResponse;
  }

  /** Adds request-scoped shared props (for guards, interceptors and middleware). */
  share(
    request: object,
    key: string | Readonly<Record<string, unknown>>,
    value?: unknown,
  ): void {
    const additions = typeof key === 'string' ? { [key]: value } : { ...key };
    assertProps(additions, 'Shared props');
    Object.assign(this.#state(request).shared, additions);
  }

  /**
   * Flashes one-time data. Stored in the host session (so it survives the
   * redirect) when available; otherwise kept for the current response only.
   * Consumed by the next rendered page.
   */
  flash(
    request: object,
    key: string | Readonly<Record<string, unknown>>,
    value?: unknown,
  ): void {
    const additions = assertRecord(
      typeof key === 'string' ? { [key]: value } : { ...key },
      'Flash data',
    );
    toJsonValue(additions, {
      preserveBigIntegers: true,
      maxDepth: this.#options.depth,
    });
    const session = this.#options.session;
    if (session?.available(request)) {
      const current = session.get(request, InertiaSessionKey.flash);
      session.set(request, InertiaSessionKey.flash, {
        ...(isPlainObject(current) ? current : {}),
        ...additions,
      });
    } else Object.assign(this.#state(request).flash, additions);
  }

  /** Emits `clearHistory: true` on the next rendered page (survives a redirect with a session). */
  clearHistory(request: object): void {
    const session = this.#options.session;
    if (session?.available(request))
      session.set(request, InertiaSessionKey.clearHistory, true);
    else this.#state(request).clearHistory = true;
  }

  /** Overrides history encryption for this request. */
  encryptHistory(request: object, encrypt = true): void {
    this.#state(request).encryptHistory = encrypt;
  }

  /** Flashes validation errors into the host session under `bag`. */
  storeErrors(request: object, errors: InertiaErrors, bag = 'default'): void {
    const session = this.#requireSession(request, 'Validation errors');
    const bags = readStoredBags(session.get(request, InertiaSessionKey.errors));
    bags[bag] = { ...(bags[bag] ?? {}), ...normalizeErrors(errors) };
    session.set(request, InertiaSessionKey.errors, bags);
  }

  /**
   * The URL of the last successful, non-prefetch GET page response stored in
   * the host session (see the `previousUrl` option), or undefined. Always a
   * same-application relative path; `back()` uses it when the `Referer` is
   * missing or unusable.
   */
  previousUrl(request: object): string | undefined {
    const session = this.#options.session;
    if (!this.#options.previousUrl || !session?.available(request))
      return undefined;
    return storablePath(session.get(request, InertiaSessionKey.previousUrl));
  }

  page(
    component: string,
    props: Readonly<Record<string, unknown>> = {},
    options?: InertiaRenderOptions,
  ): InertiaPageResult {
    return new InertiaPageResult(component, props, options);
  }

  redirect(
    url: string,
    options?: InertiaRedirectOptions,
  ): InertiaRedirectResult {
    return new InertiaRedirectResult(url, options);
  }

  back(options?: InertiaBackOptions): InertiaBackResult {
    return new InertiaBackResult(options);
  }

  location(url: string): InertiaLocationResult {
    return new InertiaLocationResult(url);
  }

  /** Imperatively renders a page through the HTTP adapter (for `@Res()` handlers and filters). */
  async render(
    request: object,
    response: object,
    component: string,
    props: Readonly<Record<string, unknown>> = {},
    options?: InertiaRenderOptions,
  ): Promise<void> {
    await this.respond(request, response, this.page(component, props, options));
  }

  /** Imperatively sends any Inertia result through the HTTP adapter. */
  async respond(
    request: object,
    response: object,
    result: InertiaResult,
  ): Promise<void> {
    this.write(response, await this.build(request, result));
  }

  /** Writes a reply (status, headers with merged `Vary`, body) via Nest's HTTP adapter. */
  write(response: object, reply: InertiaHttpReply): void {
    this.applyHead(response, reply);
    this.#adapter().reply(response, reply.body, reply.status);
  }

  /** @internal Applies status and headers, leaving the body to Nest. */
  applyHead(response: object, reply: InertiaHttpReply): void {
    this.#adapter().status(response, reply.status);
    this.applyHeaders(response, reply.headers);
  }

  /** @internal Sets headers (merging `Vary`) without touching the status. */
  applyHeaders(
    response: object,
    headers: Readonly<Record<string, string>>,
  ): void {
    const adapter = this.#adapter();
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'Vary') {
        const existing: unknown = adapter.getHeader(response, 'Vary');
        const values = new Set(
          [typeof existing === 'string' ? existing : '', value]
            .join(',')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        );
        adapter.setHeader(response, 'Vary', [...values].join(', '));
      } else adapter.setHeader(response, name, value);
    }
  }

  /** Selects the configured app: explicit id, then longest matching path prefix, then default. */
  appFor(request: object, explicit?: string): string {
    if (explicit !== undefined) {
      if (!this.#options.apps.has(explicit))
        throw new InertiaConfigurationError(
          `Unknown Inertia app "${explicit}"`,
        );
      return explicit;
    }
    const path = this.#path(request).split('?')[0] ?? '/';
    let best: { key: string; length: number } | undefined;
    for (const app of this.#options.apps.values())
      for (const prefix of app.paths)
        if (
          (prefix === '/' ||
            path === prefix ||
            path.startsWith(`${prefix}/`)) &&
          (!best || prefix.length > best.length)
        )
          best = { key: app.key, length: prefix.length };
    return best?.key ?? this.#options.defaultApp;
  }

  /** The asset version emitted for `app` on this request. */
  async version(request: object, app?: string): Promise<string | number> {
    const resolved = this.#app(app ?? this.appFor(request));
    const source = resolved.version;
    const value: unknown =
      typeof source === 'function' ? await source(request) : source;
    if (
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new InertiaConfigurationError(
        'Inertia version must resolve to a string or finite number',
      );
    return this.#options.namespaceVersions
      ? `${resolved.key}:${String(value)}`
      : value;
  }

  /**
   * Version check for Inertia GET requests (protocol "Asset Versioning"):
   * returns the `409` reply with `X-Inertia-Location` and the current
   * `X-Inertia-Version` on mismatch. Non-GET requests never conflict. Flash
   * data is not consumed, so it survives the follow-up full visit.
   */
  async versionConflict(
    request: object,
    app?: string,
  ): Promise<InertiaHttpReply | undefined> {
    const info = this.requestInfo(request);
    if (!info.inertia || info.method !== 'GET') return undefined;
    const resolved = await this.version(request, app);
    const current = String(resolved);
    // @inertiajs/core omits the header when page.version is falsy ('' or 0).
    if (!resolved && info.version === undefined) return undefined;
    if ((info.version ?? '') === current) return undefined;
    return {
      status: 409,
      headers: {
        [InertiaHeader.location]: this.#path(request),
        [InertiaHeader.version]: current,
        Vary: InertiaHeader.inertia,
      },
      body: '',
    };
  }

  /** Builds the reply for any Inertia result. */
  async build(
    request: object,
    result: InertiaResult,
    defaultApp?: string,
  ): Promise<InertiaHttpReply> {
    if (result instanceof InertiaPageResult)
      return traced(
        this.#options.instrumentation,
        'nestvexa.inertia.render',
        {
          'nestvexa.page': result.component,
          'nestvexa.inertia.kind': this.requestInfo(request).inertia
            ? 'json'
            : 'document',
        },
        () => this.#pageReply(request, result, defaultApp),
        (reply) => ({
          'nestvexa.page_bytes': Buffer.byteLength(reply.body),
          status: reply.status,
        }),
      );
    if (result instanceof InertiaLocationResult)
      return this.#locationReply(request, result.url);
    if (result instanceof InertiaBackResult) {
      const policy = { allowedOrigins: this.#options.allowedOrigins };
      const target =
        refererPath(
          plainHeader(request, 'referer'),
          plainHeader(request, 'host'),
          policy,
        ) ??
        this.previousUrl(request) ??
        result.options.fallback ??
        this.#options.fallback;
      return this.#redirectReply(request, target, result.options);
    }
    if (result instanceof InertiaRedirectResult)
      return this.#redirectReply(request, result.url, result.options);
    throw new InertiaConfigurationError('Unknown Inertia result');
  }

  /** Builds the page object for a result without producing a reply. */
  async buildPage(
    request: object,
    result: InertiaPageResult,
    defaultApp?: string,
  ): Promise<{ page: InertiaPageObject; app: ResolvedApp }> {
    const { component, options } = result;
    if (typeof component !== 'string' || !validComponent(component))
      throw new InertiaConfigurationError(
        'Inertia component must be a non-empty name',
      );
    const props = assertProps(result.props, 'Page props');
    const info = this.requestInfo(request);
    const app = this.#app(this.appFor(request, options.app ?? defaultApp));
    const state = this.#state(request);
    const version = await this.version(request, app.key);
    const shared = this.#options.share
      ? assertProps(await this.#options.share(request), 'Shared props')
      : {};
    const errors = this.#errors(request, info, options.errors);
    const resolver = new PropsResolver({
      partial: info.inertia && info.partialComponent === component,
      inertia: info.inertia,
      only: info.only,
      except: info.except,
      reset: info.reset,
      exceptOnce: info.exceptOnce,
      mergeIntent: info.mergeIntent,
      exposeSharedPropKeys: this.#options.exposeSharedPropKeys,
      maxDepth: this.#options.depth,
      now: this.#options.now,
      onRescue: (error, path) => {
        if (this.#options.onRescue)
          this.#options.onRescue(error, path, request);
        else
          this.#logger.error(
            `Rescued deferred prop "${path}"`,
            error instanceof Error ? error.stack : undefined,
          );
      },
    });
    const resolved = await resolver.resolve(
      { errors: always(errors), ...shared, ...state.shared },
      props,
    );
    const preserveBigIntegers =
      options.preserveBigIntegers ?? this.#options.preserveBigIntegers;
    const serialize = { preserveBigIntegers, maxDepth: this.#options.depth };
    const json = toJsonValue(resolved.props, serialize)
      .value as InertiaPageObject['props'];
    const session = this.#options.session;
    const sessionFlash = session
      ? pull(session, request, InertiaSessionKey.flash)
      : undefined;
    const flashData = {
      ...(isPlainObject(sessionFlash) ? sessionFlash : {}),
      ...state.flash,
      ...(options.flash ?? {}),
    };
    state.flash = {};
    const clearHistory =
      (session
        ? pull(session, request, InertiaSessionKey.clearHistory) === true
        : false) ||
      state.clearHistory ||
      options.clearHistory === true;
    state.clearHistory = false;
    const preserveFragment = session
      ? pull(session, request, InertiaSessionKey.preserveFragment) === true
      : false;
    const encrypt =
      options.encryptHistory ??
      state.encryptHistory ??
      this.#options.encryptHistory;
    const page: Record<string, unknown> = {
      component,
      props: json,
      url: this.#path(request),
      version,
      ...(toJsonValue(resolved.metadata, serialize).value as Record<
        string,
        JsonValue
      >),
    };
    if (preserveBigIntegers) page['preserveBigIntegers'] = true;
    if (clearHistory) page['clearHistory'] = true;
    if (encrypt) page['encryptHistory'] = true;
    if (Object.keys(flashData).length)
      page['flash'] = toJsonValue(flashData, serialize).value;
    if (preserveFragment) page['preserveFragment'] = true;
    return { page: page as unknown as InertiaPageObject, app };
  }

  async #pageReply(
    request: object,
    result: InertiaPageResult,
    defaultApp?: string,
  ): Promise<InertiaHttpReply> {
    const status = result.options.status ?? 200;
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      (status >= 300 && status < 400)
    )
      throw new InertiaConfigurationError(
        'Page status must be a 2xx, 4xx or 5xx code',
      );
    const { page, app } = await this.buildPage(request, result, defaultApp);
    const json = JSON.stringify(page);
    if (status === 200) this.#rememberUrl(request, page.url);
    if (this.requestInfo(request).inertia)
      return {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          [InertiaHeader.inertia]: 'true',
          Vary: InertiaHeader.inertia,
        },
        body: json,
      };
    const body = await this.#document(
      request,
      page,
      json,
      app,
      result.options.viewData ?? {},
    );
    return {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        Vary: InertiaHeader.inertia,
      },
      body,
    };
  }

  async #document(
    request: object,
    page: InertiaPageObject,
    json: string,
    app: ResolvedApp,
    viewData: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    let head = '';
    let body = `<script data-page="${app.id}" type="application/json">${escapeJsonForScript(json)}</script><div id="${app.id}"></div>`;
    if (app.ssr) {
      const context = { request, app: app.key };
      try {
        const rendered = await app.ssr.renderer.render(page, json, context);
        head = rendered.head.join('');
        body = rendered.body;
      } catch (error) {
        try {
          app.ssr.onError?.(error, context);
        } catch (observerError) {
          this.#logger.error(
            'Inertia SSR onError observer threw',
            observerError instanceof Error ? observerError.stack : undefined,
          );
        }
        if (app.ssr.mode === 'strict') throw error;
        this.#logger.warn(
          `Inertia SSR failed for ${page.component}; serving client-rendered document`,
        );
      }
    }
    const context: InertiaRootContext = {
      page,
      app: app.key,
      id: app.id,
      head,
      body,
      title: typeof app.title === 'function' ? app.title(page) : app.title,
      scripts: app.scripts,
      styles: app.styles,
      nonce: app.nonce?.(request),
      request,
      viewData,
    };
    return app.rootView(context);
  }

  #locationReply(request: object, url: string): InertiaHttpReply {
    const target = assertSafeRedirect(url, {
      allowedOrigins: this.#options.allowedOrigins,
    });
    if (this.requestInfo(request).inertia)
      return {
        status: 409,
        headers: {
          [InertiaHeader.location]: target,
          Vary: InertiaHeader.inertia,
        },
        body: '',
      };
    return {
      status: 302,
      headers: { Location: target, Vary: InertiaHeader.inertia },
      body: '',
    };
  }

  #redirectReply(
    request: object,
    url: string,
    options: InertiaRedirectOptions,
  ): InertiaHttpReply {
    const target = assertSafeRedirect(url, {
      allowedOrigins: this.#options.allowedOrigins,
    });
    const info = this.requestInfo(request);
    if (options.status !== undefined && !redirectStatuses.has(options.status))
      throw new InertiaConfigurationError(
        'Redirect status must be 301, 302, 303, 307 or 308',
      );
    if (options.preserveFragment === true)
      this.#requireSession(request, 'preserveFragment').set(
        request,
        InertiaSessionKey.preserveFragment,
        true,
      );
    const state = this.#state(request);
    if (Object.keys(state.flash).length || state.clearHistory)
      this.#requireSession(
        request,
        'Flash data or clearHistory before a redirect',
      );
    if (info.inertia && target.includes('#') && !info.prefetch)
      return {
        status: 409,
        headers: {
          [InertiaHeader.redirect]: target,
          Vary: InertiaHeader.inertia,
        },
        body: '',
      };
    let status: number = options.status ?? 302;
    if (status === 302 && ['PUT', 'PATCH', 'DELETE'].includes(info.method))
      status = 303;
    return {
      status,
      headers: { Location: target, Vary: InertiaHeader.inertia },
      body: '',
    };
  }

  #errors(
    request: object,
    info: InertiaRequestInfo,
    extra: InertiaErrors | undefined,
  ): Record<string, unknown> {
    const session = this.#options.session;
    const bags: StoredErrorBags = session
      ? readStoredBags(pull(session, request, InertiaSessionKey.errors))
      : {};
    if (extra !== undefined)
      bags['default'] = {
        ...(bags['default'] ?? {}),
        ...normalizeErrors(extra),
      };
    const display: Record<string, Record<string, string | string[]>> = {};
    for (const [bag, fields] of Object.entries(bags)) {
      const shown: Record<string, string | string[]> = {};
      for (const [field, messages] of Object.entries(fields))
        shown[field] = this.#options.allErrors ? messages : (messages[0] ?? '');
      display[bag] = shown;
    }
    // Mirrors Middleware::resolveValidationErrors in inertia-laravel v3.6.0.
    const fallback = display['default'];
    if (fallback && info.errorBag) return { [info.errorBag]: fallback };
    if (fallback) return fallback;
    return display;
  }

  /** Stores the page URL as the session's previous URL (GET, non-prefetch). */
  #rememberUrl(request: object, url: string): void {
    const session = this.#options.session;
    if (!this.#options.previousUrl || !session?.available(request)) return;
    const info = this.requestInfo(request);
    if (info.method !== 'GET' || info.prefetch) return;
    const path = storablePath(url);
    if (path !== undefined)
      session.set(request, InertiaSessionKey.previousUrl, path);
  }

  #requireSession(request: object, feature: string) {
    const session = this.#options.session;
    if (!session?.available(request))
      throw new InertiaConfigurationError(
        `${feature} requires a host session on the request`,
      );
    return session;
  }

  #app(key: string): ResolvedApp {
    const app = this.#options.apps.get(key);
    if (!app)
      throw new InertiaConfigurationError(`Unknown Inertia app "${key}"`);
    return app;
  }

  #path(request: object): string {
    if (this.#options.url)
      return relativeRequestUrl(this.#options.url(request));
    const candidate = request as { originalUrl?: unknown; url?: unknown };
    const raw =
      typeof candidate.originalUrl === 'string'
        ? candidate.originalUrl
        : typeof candidate.url === 'string'
          ? candidate.url
          : '/';
    return relativeRequestUrl(raw);
  }

  #adapter() {
    const adapter = this.#host?.httpAdapter;
    if (!adapter)
      throw new InertiaConfigurationError('Nest HTTP adapter is not available');
    return adapter;
  }
}
