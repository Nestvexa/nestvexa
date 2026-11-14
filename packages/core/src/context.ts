import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { NestvexaError } from './errors.js';

/** Primitive values that may be placed in a context contribution. */
export type ContextValue = string | number | boolean;
export interface RequestPrincipal {
  readonly id: string;
  readonly roles?: readonly string[];
}
/**
 * Contribution hook (see `NestvexaExtension.contributeContext`): returns
 * server-side primitive fields stored under `context.extensions[name]`.
 */
export type RequestContextContributor = (
  request: object,
) =>
  | Readonly<Record<string, ContextValue>>
  | undefined
  | Promise<Readonly<Record<string, ContextValue>> | undefined>;

export interface RequestContextOptions {
  /** Incoming correlation header (default `x-request-id`). */
  readonly correlationHeader?: string;
  /**
   * Accept a well-formed incoming correlation ID (8–128 of `A-Za-z0-9._:-`)
   * instead of generating one. Default true; disable when no trusted proxy
   * sets the header.
   */
  readonly trustIncomingCorrelation?: boolean;
  readonly resolveTenant?: (
    request: object,
  ) => string | undefined | Promise<string | undefined>;
  /** Opaque session identifier; server-only, never in the public context. */
  readonly resolveSession?: (
    request: object,
  ) => string | undefined | Promise<string | undefined>;
  readonly resolvePrincipal?: (
    request: object,
  ) => RequestPrincipal | undefined | Promise<RequestPrincipal | undefined>;
}
export const NESTVEXA_REQUEST_CONTEXT_OPTIONS = Symbol(
  'NESTVEXA_REQUEST_CONTEXT_OPTIONS',
);

/** Safe for templates and browser responses: no session, principal ID or roles. */
export interface PublicRequestContext {
  readonly correlationId: string;
  readonly cspNonce: string;
  readonly tenant?: string;
  readonly authenticated: boolean;
}
export interface NestvexaRequestContext {
  readonly correlationId: string;
  /** 128-bit base64 nonce for `script-src 'nonce-…'`; one per request. */
  readonly cspNonce: string;
  readonly tenant?: string;
  readonly session?: string;
  readonly principal?: RequestPrincipal;
  /** Extension contributions by extension name (server-side only). */
  readonly extensions: Readonly<
    Record<string, Readonly<Record<string, ContextValue>>>
  >;
  readonly public: PublicRequestContext;
}
/**
 * The kernel identity of a request (`RequestContextFactory.identity`): the
 * principal and tenant the configured server-side resolvers returned, and
 * nothing else. Feature transports that opt in (`kernelIdentity` on Live,
 * actions, uploads, realtime and Inertia) attach exactly this object to the
 * identity they hand to host policies, so every transport sees one user and
 * one tenant. The kernel never reads a tenant or principal from the request
 * body, query or a header of its own; only the host resolvers decide.
 */
export interface RequestIdentity {
  readonly authenticated: boolean;
  readonly principal?: RequestPrincipal;
  readonly tenant?: string;
}

const correlationPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const tenantPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const headerPattern = /^[a-z][a-z0-9-]{0,63}$/;
const extensionPattern = /^[a-z][a-z0-9._-]{0,63}$/;

function headerValue(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function invalid(message: string): never {
  throw new NestvexaError('INVALID_CONFIGURATION', message);
}

/**
 * `RequestContextFactory` (master plan 5.2): one immutable context per request
 * object with tenant, session, principal, correlation ID and CSP nonce, plus a
 * public subset safe to render. Resolver failures reject (fail closed).
 * `correlationId(request)` is synchronous and stable for the request, so
 * filters and loggers can use it even when `create()` never ran.
 */
@Injectable()
export class RequestContextFactory {
  readonly #options: RequestContextOptions;
  readonly #header: string;
  readonly #contexts = new WeakMap<object, Promise<NestvexaRequestContext>>();
  readonly #correlations = new WeakMap<object, string>();
  readonly #identities = new WeakMap<object, Promise<RequestIdentity>>();
  readonly #contributors = new Map<string, RequestContextContributor>();
  constructor(
    @Optional()
    @Inject(NESTVEXA_REQUEST_CONTEXT_OPTIONS)
    options: RequestContextOptions | null = null,
  ) {
    const selected = options ?? {};
    const header = (selected.correlationHeader ?? 'x-request-id').toLowerCase();
    if (!headerPattern.test(header))
      invalid('Invalid request context correlation header');
    for (const key of [
      'resolveTenant',
      'resolveSession',
      'resolvePrincipal',
    ] as const)
      if (selected[key] !== undefined && typeof selected[key] !== 'function')
        invalid(`Request context ${key} must be a function`);
    if (
      selected.trustIncomingCorrelation !== undefined &&
      typeof selected.trustIncomingCorrelation !== 'boolean'
    )
      invalid('Request context trustIncomingCorrelation must be a boolean');
    this.#options = selected;
    this.#header = header;
  }

  /** Register an extension contribution hook (startup only). */
  contribute(name: string, contributor: RequestContextContributor): void {
    if (!extensionPattern.test(name) || typeof contributor !== 'function')
      invalid('Invalid request context contributor');
    if (this.#contributors.has(name))
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Duplicate request context contributor ${name}`,
      );
    this.#contributors.set(name, contributor);
  }

  /** Stable correlation ID for this request object (validated incoming or random). */
  correlationId(request: object): string {
    const known = this.#correlations.get(request);
    if (known) return known;
    const incoming = headerValue(request, this.#header);
    const id =
      this.#options.trustIncomingCorrelation !== false &&
      incoming !== undefined &&
      correlationPattern.test(incoming)
        ? incoming
        : randomUUID();
    this.#correlations.set(request, id);
    return id;
  }

  /** The request's context; repeated calls for one request share one result. */
  create(request: object): Promise<NestvexaRequestContext> {
    if (typeof request !== 'object' || request === null)
      return Promise.reject(
        new NestvexaError('INVALID_CONFIGURATION', 'A request is required'),
      );
    const known = this.#contexts.get(request);
    if (known) return known;
    const created = this.#build(request);
    this.#contexts.set(request, created);
    return created;
  }

  /**
   * The request's kernel identity: the principal and tenant of `create()`,
   * as one frozen object shared by every caller for this request (the
   * `kernelIdentity` source of Live, actions, uploads, realtime and
   * Inertia). Resolver failures reject, so transports fail closed.
   */
  identity(request: object): Promise<RequestIdentity> {
    if (typeof request !== 'object' || request === null)
      return Promise.reject(
        new NestvexaError('INVALID_CONFIGURATION', 'A request is required'),
      );
    const known = this.#identities.get(request);
    if (known) return known;
    const created = this.create(request).then(({ principal, tenant }) =>
      Object.freeze({
        authenticated: principal !== undefined,
        ...(principal === undefined ? {} : { principal }),
        ...(tenant === undefined ? {} : { tenant }),
      }),
    );
    this.#identities.set(request, created);
    return created;
  }

  async #build(request: object): Promise<NestvexaRequestContext> {
    const correlationId = this.correlationId(request);
    const cspNonce = randomBytes(16).toString('base64');
    const tenant = await this.#options.resolveTenant?.(request);
    if (
      tenant !== undefined &&
      (typeof tenant !== 'string' || !tenantPattern.test(tenant))
    )
      invalid('Tenant resolver returned an invalid tenant');
    const session = await this.#options.resolveSession?.(request);
    if (
      session !== undefined &&
      (typeof session !== 'string' || !session || session.length > 1024)
    )
      invalid('Session resolver returned an invalid session');
    const principal = await this.#options.resolvePrincipal?.(request);
    let frozenPrincipal: RequestPrincipal | undefined;
    if (principal !== undefined) {
      if (
        typeof principal !== 'object' ||
        principal === null ||
        typeof principal.id !== 'string' ||
        !principal.id ||
        principal.id.length > 256 ||
        (principal.roles !== undefined &&
          (!Array.isArray(principal.roles) ||
            principal.roles.length > 64 ||
            principal.roles.some((role) => typeof role !== 'string')))
      )
        invalid('Principal resolver returned an invalid principal');
      frozenPrincipal = Object.freeze({
        id: principal.id,
        ...(principal.roles === undefined
          ? {}
          : { roles: Object.freeze([...principal.roles]) }),
      });
    }
    const extensions = Object.create(null) as Record<
      string,
      Readonly<Record<string, ContextValue>>
    >;
    for (const [name, contributor] of this.#contributors) {
      const contribution = await contributor(request);
      if (contribution === undefined) continue;
      const copy = Object.create(null) as Record<string, ContextValue>;
      if (typeof contribution !== 'object' || contribution === null)
        invalid(`Context contribution ${name} must be an object`);
      for (const [key, value] of Object.entries(contribution)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
          !(
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          )
        )
          invalid(`Context contribution ${name} must hold primitive fields`);
        copy[key] = value;
      }
      extensions[name] = Object.freeze(copy);
    }
    return Object.freeze({
      correlationId,
      cspNonce,
      ...(tenant === undefined ? {} : { tenant }),
      ...(session === undefined ? {} : { session }),
      ...(frozenPrincipal === undefined ? {} : { principal: frozenPrincipal }),
      extensions: Object.freeze(extensions),
      public: Object.freeze({
        correlationId,
        cspNonce,
        ...(tenant === undefined ? {} : { tenant }),
        authenticated: frozenPrincipal !== undefined,
      }),
    });
  }
}
