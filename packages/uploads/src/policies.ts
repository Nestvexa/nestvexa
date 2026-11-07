import { timingSafeEqual } from 'node:crypto';
import type { UploadIdentity, UploadOperation } from './options.js';

/** Policy kinds uploads registers; the names match `SecurityPolicyKind` in @nestvexa/core. */
export type UploadPolicyKind =
  'origin' | 'csrf' | 'action-authorization' | 'upload-quota';

/** The policies uploads enforces, in the shape of the kernel policy contracts. */
export interface UploadSecurityPolicies {
  readonly origin: { allowed(origin: string | undefined): boolean };
  readonly csrf: {
    /** `subject` is the identity uploads already resolved for this request. */
    verify(request: object, subject?: unknown): boolean | Promise<boolean>;
  };
  readonly 'action-authorization': {
    /** `resource` is the purpose, `action` one of `upload`, `finalize`, `discard`. */
    authorize(
      subject: unknown,
      resource: string,
      action: string,
    ): boolean | Promise<boolean>;
  };
  /**
   * Per-identity limits: the largest per-purpose file size and the pending
   * file and byte quotas of one identity binding.
   */
  readonly 'upload-quota': {
    readonly maxFileBytes: number;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
  };
}

/**
 * Structural view of a kernel policy registry such as `SecurityPolicyRegistry`
 * from @nestvexa/core (this package imports no Nestvexa package). Uploads
 * registers its policies, including its quotas, under its owner name and asks
 * the registry for every origin, CSRF-header and authorization decision.
 */
export interface UploadPolicyRegistry {
  register(
    kind: 'origin',
    owner: string,
    policy: UploadSecurityPolicies['origin'],
  ): void;
  register(
    kind: 'csrf',
    owner: string,
    policy: UploadSecurityPolicies['csrf'],
  ): void;
  register(
    kind: 'action-authorization',
    owner: string,
    policy: UploadSecurityPolicies['action-authorization'],
  ): void;
  register(
    kind: 'upload-quota',
    owner: string,
    policy: UploadSecurityPolicies['upload-quota'],
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

/** The decisions the upload routes ask for; fails closed on errors. */
export interface UploadPolicyEnforcer {
  originAllowed(origin: string | undefined): boolean;
  verifyCsrf(request: object, identity: UploadIdentity): Promise<boolean>;
  authorize(
    identity: UploadIdentity,
    purpose: string,
    operation: UploadOperation,
  ): Promise<boolean>;
}

const operations: readonly string[] = ['upload', 'finalize', 'discard'];

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
function identityOf(value: unknown): UploadIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const binding: unknown = Reflect.get(value, 'binding');
  const csrfToken: unknown = Reflect.get(value, 'csrfToken');
  const tenant: unknown = Reflect.get(value, 'tenant');
  if (
    typeof binding !== 'string' ||
    binding.length < 16 ||
    binding.length > 1024 ||
    typeof csrfToken !== 'string' ||
    csrfToken.length < 32 ||
    csrfToken.length > 256 ||
    (tenant !== undefined && typeof tenant !== 'string')
  )
    return undefined;
  return { binding, csrfToken, ...(tenant === undefined ? {} : { tenant }) };
}

/**
 * The one implementation of the upload security policies, built from the
 * host options: exact `Origin`, the `x-nestvexa-csrf` header compared in
 * constant time, the host `authorize` callback (only a literal `true`
 * admits) and the per-identity quotas.
 */
export function uploadSecurityPolicies(options: {
  readonly origin: string;
  readonly resolveIdentity: (request: object) => unknown;
  readonly authorize: (
    identity: UploadIdentity,
    purpose: string,
    operation: UploadOperation,
  ) => boolean | Promise<boolean>;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}): UploadSecurityPolicies {
  const { origin, resolveIdentity, authorize } = options;
  return Object.freeze({
    origin: Object.freeze({
      allowed: (candidate: string | undefined) => candidate === origin,
    }),
    csrf: Object.freeze({
      verify: async (request: object, subject?: unknown) => {
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
          operations.includes(action) &&
          (await authorize(identity, resource, action as UploadOperation)) ===
            true
        );
      },
    }),
    'upload-quota': Object.freeze({
      maxFileBytes: options.maxFileBytes,
      maxFiles: options.maxFiles,
      maxTotalBytes: options.maxTotalBytes,
    }),
  });
}

export function isUploadPolicyRegistry(
  value: unknown,
): value is UploadPolicyRegistry {
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
 * Register the upload policies in `registry` under `owner` (a duplicate
 * owner fails startup) and return an enforcer that consults the registry.
 * Without a registry the policies are enforced directly.
 */
export function uploadPolicyEnforcer(
  policies: UploadSecurityPolicies,
  registry: UploadPolicyRegistry | undefined,
  owner: string,
): UploadPolicyEnforcer {
  if (!registry)
    return Object.freeze({
      originAllowed: (origin: string | undefined) =>
        policies.origin.allowed(origin) === true,
      verifyCsrf: (request: object, identity: UploadIdentity) =>
        settled(() => policies.csrf.verify(request, identity)),
      authorize: (
        identity: UploadIdentity,
        purpose: string,
        operation: UploadOperation,
      ) =>
        settled(() =>
          policies['action-authorization'].authorize(
            identity,
            purpose,
            operation,
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
  registry.register('upload-quota', owner, policies['upload-quota']);
  return Object.freeze({
    originAllowed: (origin: string | undefined) => {
      try {
        return registry.originAllowed(owner, origin) === true;
      } catch {
        return false;
      }
    },
    verifyCsrf: (request: object, identity: UploadIdentity) =>
      settled(() => registry.verifyCsrf(owner, request, identity)),
    authorize: (
      identity: UploadIdentity,
      purpose: string,
      operation: UploadOperation,
    ) => settled(() => registry.authorize(owner, identity, purpose, operation)),
  });
}
