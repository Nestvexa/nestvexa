import { timingSafeEqual } from 'node:crypto';
import { kernelIdentityOf } from './kernel.js';
import type { LiveKernelIdentity } from './kernel.js';

/** Host-resolved identity shared by every Live check (see `LiveHostOptions`). */
interface Identity extends LiveKernelIdentity {
  readonly binding: string;
  readonly csrfToken: string;
}

/** Policy kinds Live registers; the names match `SecurityPolicyKind` in @nestvexa/core. */
export type LivePolicyKind =
  'origin' | 'csrf' | 'action-authorization' | 'snapshot';

/** The policies Live enforces, in the shape of the kernel policy contracts. */
export interface LiveSecurityPolicies {
  readonly origin: { allowed(origin: string | undefined): boolean };
  readonly csrf: {
    /** `subject` is the identity Live already resolved for this request. */
    verify(request: object, subject?: unknown): boolean | Promise<boolean>;
  };
  readonly 'action-authorization': {
    authorize(
      subject: unknown,
      resource: string,
      action: string,
    ): boolean | Promise<boolean>;
  };
  /** Present only when the store declares its TTL. */
  readonly snapshot?: {
    readonly storage: 'server';
    readonly ttlMs: number;
    readonly bindsIdentity: true;
  };
}

/**
 * Structural view of a kernel policy registry such as `SecurityPolicyRegistry`
 * from @nestvexa/core. Live imports no kernel code (ADR 0030); any object with
 * these methods fits. When configured, Live registers its policies once under
 * its owner name and asks the registry for every origin, CSRF and
 * authorization decision, so the registry is the single source of truth.
 */
export interface LivePolicyRegistry {
  has(kind: LivePolicyKind, owner: string): boolean;
  register(
    kind: 'origin',
    owner: string,
    policy: LiveSecurityPolicies['origin'],
  ): void;
  register(
    kind: 'csrf',
    owner: string,
    policy: LiveSecurityPolicies['csrf'],
  ): void;
  register(
    kind: 'action-authorization',
    owner: string,
    policy: LiveSecurityPolicies['action-authorization'],
  ): void;
  register(
    kind: 'snapshot',
    owner: string,
    policy: NonNullable<LiveSecurityPolicies['snapshot']>,
  ): void;
  originAllowed(owner: string, origin: string | undefined): boolean;
  verifyCsrf(
    owner: string,
    request: object,
    subject?: unknown,
  ): boolean | Promise<boolean>;
  authorize(
    owner: string,
    subject: unknown,
    resource: string,
    action: string,
  ): boolean | Promise<boolean>;
}

/** The decisions Live's admission paths ask for; fails closed on errors. */
export interface LivePolicyEnforcer {
  originAllowed(origin: string | undefined): boolean;
  verifyCsrf(request: object, identity: Identity): Promise<boolean>;
  authorize(
    identity: Identity,
    component: string,
    action: string,
  ): Promise<boolean>;
}

const ownerPattern = /^[a-z][a-z0-9._-]{0,63}$/;

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function identityOf(value: unknown): Identity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const binding: unknown = Reflect.get(value, 'binding');
  const csrfToken: unknown = Reflect.get(value, 'csrfToken');
  if (
    typeof binding !== 'string' ||
    binding.length < 16 ||
    binding.length > 1024 ||
    typeof csrfToken !== 'string' ||
    csrfToken.length < 32 ||
    csrfToken.length > 256
  )
    return undefined;
  // The kernel principal and tenant Live attached travel with the identity.
  const kernel = kernelIdentityOf(value);
  return kernel === undefined
    ? undefined
    : Object.freeze({ binding, csrfToken, ...kernel });
}

/**
 * The one implementation of Live's security policies, built from the host
 * options: exact `Origin`, the `x-nestvexa-csrf` header compared in constant
 * time with the identity's token, and the host `authorize` callback (only a
 * literal `true` admits). Standalone Live enforces these directly; with a
 * `policies` registry Live registers exactly these objects and enforces them
 * through the registry.
 */
export function liveSecurityPolicies(options: {
  readonly origin: string;
  readonly resolveIdentity: (request: object) => unknown;
  readonly authorize: (
    identity: Identity,
    component: string,
    action: string,
  ) => boolean | Promise<boolean>;
  readonly ttlMs?: number;
}): LiveSecurityPolicies {
  const { origin, resolveIdentity, authorize } = options;
  return Object.freeze({
    origin: Object.freeze({
      allowed: (candidate: string | undefined) => candidate === origin,
    }),
    csrf: Object.freeze({
      verify: async (request: object, subject?: unknown) => {
        // Without a resolved identity (a host route asking the registry), resolve it.
        const identity = identityOf(
          subject === undefined ? await resolveIdentity(request) : subject,
        );
        return (
          identity !== undefined &&
          equal(header(request, 'x-nestvexa-csrf') ?? '', identity.csrfToken)
        );
      },
    }),
    'action-authorization': Object.freeze({
      authorize: async (subject: unknown, resource: string, action: string) => {
        const identity = identityOf(subject);
        return (
          identity !== undefined &&
          (await authorize(identity, resource, action)) === true
        );
      },
    }),
    ...(options.ttlMs === undefined
      ? {}
      : {
          snapshot: Object.freeze({
            storage: 'server' as const,
            ttlMs: options.ttlMs,
            bindsIdentity: true as const,
          }),
        }),
  });
}

export function isLivePolicyRegistry(
  value: unknown,
): value is LivePolicyRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['has', 'register', 'originAllowed', 'verifyCsrf', 'authorize'].every(
      (name) => typeof Reflect.get(value, name) === 'function',
    )
  );
}
export function validPolicyOwner(value: unknown): value is string {
  return typeof value === 'string' && ownerPattern.test(value);
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
 * Register Live's policies in `registry` under `owner` (a duplicate owner
 * fails startup) and return an enforcer that consults the registry for every
 * decision. Without a registry the policies are enforced directly.
 */
export function livePolicyEnforcer(
  policies: LiveSecurityPolicies,
  registry?: LivePolicyRegistry,
  owner = 'live',
): LivePolicyEnforcer {
  if (!registry)
    return Object.freeze({
      originAllowed: (origin: string | undefined) =>
        policies.origin.allowed(origin) === true,
      verifyCsrf: (request: object, identity: Identity) =>
        settled(() => policies.csrf.verify(request, identity)),
      authorize: (identity: Identity, component: string, action: string) =>
        settled(() =>
          policies['action-authorization'].authorize(
            identity,
            component,
            action,
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
  if (policies.snapshot)
    registry.register('snapshot', owner, policies.snapshot);
  return Object.freeze({
    originAllowed: (origin: string | undefined) => {
      try {
        return registry.originAllowed(owner, origin) === true;
      } catch {
        return false;
      }
    },
    verifyCsrf: (request: object, identity: Identity) =>
      settled(() => registry.verifyCsrf(owner, request, identity)),
    authorize: (identity: Identity, component: string, action: string) =>
      settled(() => registry.authorize(owner, identity, component, action)),
  });
}
