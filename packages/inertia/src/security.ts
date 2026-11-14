import { createHash, timingSafeEqual } from 'node:crypto';
import { InertiaConfigurationError } from './errors.js';
import { kernelIdentityOf } from './kernel.js';
import type { InertiaKernelIdentity } from './kernel.js';

/**
 * Opt-in Inertia request security (CORE-047). Without it CSRF and origin
 * checks stay host-owned, as before. With it Inertia builds origin, CSRF
 * and page-authorization policies, registers them in the kernel registry
 * (`policies`, owner `inertia`) when one is configured, and enforces them:
 * `InertiaSecurityGuard` checks origin and CSRF on unsafe methods, and every
 * page render asks the authorization policy for the component.
 */
export interface InertiaSecurityOptions {
  /** Exact HTTP(S) origin(s) allowed to send unsafe (non-GET/HEAD/OPTIONS) requests. */
  readonly origin: string | readonly string[];
  /**
   * The request's expected CSRF token (16–512 characters, for example the
   * per-session secret the host mirrors into the `XSRF-TOKEN` cookie). It
   * is compared in constant time with the `X-XSRF-TOKEN` header the
   * official client sends (URL-decoded). Undefined denies.
   */
  readonly csrfToken: (
    request: object,
  ) => string | undefined | PromiseLike<string | undefined>;
  /**
   * Page authorization: renders `component` only for a literal `true`, else
   * 403. `identity` is the kernel identity with `kernelIdentity`, otherwise
   * empty. Default: every component may render.
   */
  readonly authorize?: (
    identity: InertiaKernelIdentity,
    component: string,
    request: object,
  ) => boolean | PromiseLike<boolean>;
}

/** Policy kinds Inertia registers; the names match `SecurityPolicyKind` in @nestvexa/core. */
export type InertiaPolicyKind = 'origin' | 'csrf' | 'action-authorization';

/** The policies Inertia enforces, in the shape of the kernel policy contracts. */
export interface InertiaSecurityPolicies {
  readonly origin: { allowed(origin: string | undefined): boolean };
  readonly csrf: {
    verify(
      request: object,
      subject?: unknown,
      token?: string,
    ): boolean | Promise<boolean>;
  };
  /** `resource` is the page component, `action` is always `render`. */
  readonly 'action-authorization': {
    authorize(
      subject: unknown,
      resource: string,
      action: string,
      request?: object,
    ): boolean | Promise<boolean>;
  };
}

/**
 * Structural view of a kernel policy registry such as `SecurityPolicyRegistry`
 * from @nestvexa/core (this package imports no kernel code).
 */
export interface InertiaPolicyRegistry {
  register(
    kind: 'origin',
    owner: string,
    policy: InertiaSecurityPolicies['origin'],
  ): void;
  register(
    kind: 'csrf',
    owner: string,
    policy: InertiaSecurityPolicies['csrf'],
  ): void;
  register(
    kind: 'action-authorization',
    owner: string,
    policy: InertiaSecurityPolicies['action-authorization'],
  ): void;
  originAllowed(owner: string, origin: string | undefined): boolean;
  verifyCsrf(
    owner: string,
    request: object,
    subject?: unknown,
    token?: string,
  ): boolean | Promise<boolean>;
  authorize(
    owner: string,
    subject: unknown,
    resource: string,
    action: string,
    request?: object,
  ): boolean | Promise<boolean>;
}

/** The decisions Inertia asks for; every one fails closed. */
export interface InertiaPolicyEnforcer {
  originAllowed(origin: string | undefined): boolean;
  verifyCsrf(request: object): Promise<boolean>;
  authorize(
    identity: InertiaKernelIdentity,
    component: string,
    request: object,
  ): Promise<boolean>;
}

const XSRF_HEADER = 'x-xsrf-token';

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512;
}
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
function decoded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
function exactOrigins(value: unknown): ReadonlySet<string> {
  const list: unknown = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length)
    throw new InertiaConfigurationError(
      'security.origin must be an exact HTTP(S) origin or a non-empty list',
    );
  const origins = new Set<string>();
  for (const entry of list as unknown[]) {
    let parsed: URL | undefined;
    try {
      parsed = typeof entry === 'string' ? new URL(entry) : undefined;
    } catch {
      parsed = undefined;
    }
    if (
      typeof entry !== 'string' ||
      !parsed ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== entry
    )
      throw new InertiaConfigurationError(
        `security.origin ${String(entry)} must be an exact origin such as https://app.example`,
      );
    origins.add(entry);
  }
  return origins;
}

/** Validate `security` once at startup and build its policies. */
export function inertiaSecurityPolicies(
  options: InertiaSecurityOptions,
): InertiaSecurityPolicies {
  if (typeof options !== 'object' || options === null)
    throw new InertiaConfigurationError('security must be an object');
  for (const key of Object.keys(options))
    if (!['origin', 'csrfToken', 'authorize'].includes(key))
      throw new InertiaConfigurationError(`Unknown security option ${key}`);
  const origins = exactOrigins(options.origin);
  const { csrfToken, authorize } = options;
  if (typeof csrfToken !== 'function')
    throw new InertiaConfigurationError(
      'security.csrfToken must be a function returning the expected token',
    );
  if (authorize !== undefined && typeof authorize !== 'function')
    throw new InertiaConfigurationError(
      'security.authorize must be a function',
    );
  return Object.freeze({
    origin: Object.freeze({
      allowed: (candidate: string | undefined) =>
        candidate !== undefined && origins.has(candidate),
    }),
    csrf: Object.freeze({
      verify: async (request: object, _subject?: unknown, proof?: string) => {
        const expected: unknown = await csrfToken(request);
        const sent = proof ?? decoded(header(request, XSRF_HEADER));
        return (
          token(expected) &&
          token(sent) &&
          timingSafeEqual(digest(sent), digest(expected))
        );
      },
    }),
    'action-authorization': Object.freeze({
      authorize: async (
        subject: unknown,
        resource: string,
        action: string,
        request?: object,
      ) => {
        const identity = kernelIdentityOf(subject);
        if (
          !identity ||
          action !== 'render' ||
          typeof request !== 'object' ||
          request === null
        )
          return false;
        return authorize === undefined
          ? true
          : (await authorize(identity, resource, request)) === true;
      },
    }),
  });
}

export function isInertiaPolicyRegistry(
  value: unknown,
): value is InertiaPolicyRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['register', 'originAllowed', 'verifyCsrf', 'authorize'].every(
      (name) => typeof Reflect.get(value, name) === 'function',
    )
  );
}

async function settled(
  decide: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return (await decide()) === true;
  } catch {
    return false;
  }
}

/**
 * Register the Inertia policies in `registry` under `owner` (a duplicate
 * owner fails startup) and return an enforcer that consults the registry for
 * every decision. Without a registry the policies are enforced directly.
 */
export function inertiaPolicyEnforcer(
  policies: InertiaSecurityPolicies,
  registry: InertiaPolicyRegistry | undefined,
  owner: string,
): InertiaPolicyEnforcer {
  if (!registry)
    return Object.freeze({
      originAllowed: (origin: string | undefined) => {
        try {
          return policies.origin.allowed(origin) === true;
        } catch {
          return false;
        }
      },
      verifyCsrf: (request: object) =>
        settled(() => policies.csrf.verify(request)),
      authorize: (
        identity: InertiaKernelIdentity,
        component: string,
        request: object,
      ) =>
        settled(() =>
          policies['action-authorization'].authorize(
            identity,
            component,
            'render',
            request,
          ),
        ),
    });
  registry.register('origin', owner, policies.origin);
  registry.register('csrf', owner, policies.csrf);
  registry.register(
    'action-authorization',
    owner,
    policies['action-authorization'],
  );
  return Object.freeze({
    originAllowed: (origin: string | undefined) => {
      try {
        return registry.originAllowed(owner, origin) === true;
      } catch {
        return false;
      }
    },
    verifyCsrf: (request: object) =>
      settled(() => registry.verifyCsrf(owner, request)),
    authorize: (
      identity: InertiaKernelIdentity,
      component: string,
      request: object,
    ) =>
      settled(() =>
        registry.authorize(owner, identity, component, 'render', request),
      ),
  });
}
