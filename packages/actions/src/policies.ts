import { createHash, timingSafeEqual } from 'node:crypto';
import { kernelIdentityOf } from './kernel.js';
import type { ActionDescriptor } from './metadata.js';
import type { ActionIdentity } from './state.js';

/** Policy kinds server actions register; the names match `SecurityPolicyKind` in @nestvexa/core. */
export type ActionPolicyKind = 'origin' | 'csrf' | 'action-authorization';

/** The policies server actions enforce, in the shape of the kernel policy contracts. */
export interface ActionSecurityPolicies {
  readonly origin: { allowed(origin: string | undefined): boolean };
  /** Absent when `csrf.required` is false (bearer or mTLS authentication). */
  readonly csrf?: {
    /** `subject` is the identity already resolved; `token` replaces the header. */
    verify(
      request: object,
      subject?: unknown,
      token?: string,
    ): boolean | Promise<boolean>;
  };
  readonly 'action-authorization': {
    /**
     * `resource` is the group id and `action` the action reference
     * (`id`, or `id/v<version>` for versioned actions; `_jobs` uses
     * `status`/`cancel`). `request` is required: the host `authorize`
     * receives it, so a decision without one is denied.
     */
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
 * from @nestvexa/core (this package imports no Nestvexa package). Actions
 * register their policies under the owner name and ask the registry for
 * every origin, CSRF and authorization decision.
 */
export interface ActionPolicyRegistry {
  register(
    kind: 'origin',
    owner: string,
    policy: ActionSecurityPolicies['origin'],
  ): void;
  register(
    kind: 'csrf',
    owner: string,
    policy: NonNullable<ActionSecurityPolicies['csrf']>,
  ): void;
  register(
    kind: 'action-authorization',
    owner: string,
    policy: ActionSecurityPolicies['action-authorization'],
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

/**
 * The decisions the admission gate asks for. Registry decisions fail closed
 * (an error denies); without a registry a throwing host `authorize` fails
 * the call with 500, as it always has.
 */
export interface ActionPolicyEnforcer {
  originAllowed(origin: string | undefined): boolean;
  /** True when CSRF is not required. */
  verifyCsrf(request: object, identity: ActionIdentity): Promise<boolean>;
  authorize(
    identity: ActionIdentity,
    descriptor: ActionDescriptor,
    request: object,
  ): Promise<boolean>;
}

/** The registry `action` of a descriptor: `id`, or `id/v<version>`. */
export function actionReference(descriptor: ActionDescriptor): string {
  return descriptor.version === null
    ? descriptor.action
    : `${descriptor.action}/v${descriptor.version}`;
}

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
/** Constant-time comparison over fixed-length digests (no length oracle). */
function secretEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}
function identityOf(value: unknown): ActionIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const subject: unknown = Reflect.get(value, 'subject');
  const tenant: unknown = Reflect.get(value, 'tenant');
  const csrfToken: unknown = Reflect.get(value, 'csrfToken');
  if (
    typeof subject !== 'string' ||
    subject.length < 1 ||
    subject.length > 512 ||
    (tenant !== undefined &&
      (typeof tenant !== 'string' ||
        tenant.length < 1 ||
        tenant.length > 512)) ||
    (csrfToken !== undefined && typeof csrfToken !== 'string')
  )
    return undefined;
  const kernel = kernelIdentityOf({
    principal: Reflect.get(value, 'principal'),
  });
  if (!kernel) return undefined;
  return Object.freeze({
    subject,
    ...(tenant === undefined ? {} : { tenant }),
    ...(csrfToken === undefined ? {} : { csrfToken }),
    ...kernel,
  });
}

/**
 * The one implementation of the server-action security policies, built from
 * the host options: exact `Origin` allowlist, the CSRF header compared in
 * constant time with the identity's token (when required), and the host
 * `authorize` callback (only a literal `true` admits).
 */
export function actionSecurityPolicies(options: {
  readonly origins: ReadonlySet<string>;
  readonly csrfRequired: boolean;
  readonly csrfHeader: string;
  readonly authorize: (
    identity: ActionIdentity,
    descriptor: ActionDescriptor,
    request: object,
  ) => boolean | Promise<boolean>;
  /** Registered descriptors by `group` and action reference. */
  readonly descriptor: (
    group: string,
    reference: string,
  ) => ActionDescriptor | undefined;
}): ActionSecurityPolicies {
  const { origins, csrfHeader, authorize, descriptor } = options;
  return Object.freeze({
    origin: Object.freeze({
      allowed: (candidate: string | undefined) =>
        candidate !== undefined && origins.has(candidate),
    }),
    ...(options.csrfRequired
      ? {
          csrf: Object.freeze({
            verify: (request: object, subject?: unknown, token?: string) => {
              const expected = identityOf(subject)?.csrfToken;
              const sent =
                typeof token === 'string' ? token : header(request, csrfHeader);
              return (
                expected !== undefined &&
                sent !== undefined &&
                secretEqual(sent, expected)
              );
            },
          }),
        }
      : {}),
    'action-authorization': Object.freeze({
      authorize: async (
        subject: unknown,
        resource: string,
        action: string,
        request?: object,
      ) => {
        const identity = identityOf(subject);
        const target = descriptor(resource, action);
        return (
          identity !== undefined &&
          target !== undefined &&
          typeof request === 'object' &&
          request !== null &&
          (await authorize(identity, target, request)) === true
        );
      },
    }),
  });
}

export function isActionPolicyRegistry(
  value: unknown,
): value is ActionPolicyRegistry {
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
 * Register the action policies in `registry` under `owner` (a duplicate
 * owner fails startup) and return an enforcer that consults the registry
 * for every decision. Without a registry the policies are enforced directly.
 */
export function actionPolicyEnforcer(
  policies: ActionSecurityPolicies,
  registry: ActionPolicyRegistry | undefined,
  owner: string,
): ActionPolicyEnforcer {
  const csrf = policies.csrf;
  if (!registry)
    return Object.freeze({
      originAllowed: (origin: string | undefined) =>
        policies.origin.allowed(origin) === true,
      verifyCsrf: (request: object, identity: ActionIdentity) =>
        csrf
          ? settled(() => csrf.verify(request, identity))
          : Promise.resolve(true),
      // A throwing host policy still fails the call (500), as before the registry.
      authorize: async (
        identity: ActionIdentity,
        descriptor: ActionDescriptor,
        request: object,
      ) =>
        (await policies['action-authorization'].authorize(
          identity,
          descriptor.group,
          actionReference(descriptor),
          request,
        )) === true,
    });
  registry.register('origin', owner, policies.origin);
  if (csrf) registry.register('csrf', owner, csrf);
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
    verifyCsrf: (request: object, identity: ActionIdentity) =>
      csrf
        ? settled(() => registry.verifyCsrf(owner, request, identity))
        : Promise.resolve(true),
    authorize: (
      identity: ActionIdentity,
      descriptor: ActionDescriptor,
      request: object,
    ) =>
      settled(() =>
        registry.authorize(
          owner,
          identity,
          descriptor.group,
          actionReference(descriptor),
          request,
        ),
      ),
  });
}
