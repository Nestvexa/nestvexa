import { Injectable } from '@nestjs/common';
import { NestvexaError } from './errors.js';

/** Contracts per policy kind (master plan 5.2 `SecurityPolicyRegistry`). */
export interface SecurityPolicies {
  /** Verifies the request's anti-CSRF proof. */
  readonly csrf: {
    verify(request: object): boolean | Promise<boolean>;
  };
  /** Decides whether a request `Origin` may perform unsafe requests. */
  readonly origin: {
    allowed(origin: string | undefined): boolean;
  };
  /** How component state references are protected. */
  readonly snapshot: {
    readonly storage: 'server' | 'signed';
    readonly ttlMs: number;
    /** Must be true: state references are bound to the identity. */
    readonly bindsIdentity: true;
  };
  /** Per-action authorization of a subject on a resource. */
  readonly 'action-authorization': {
    authorize(
      subject: unknown,
      resource: string,
      action: string,
    ): boolean | Promise<boolean>;
  };
  /** Upload limits. */
  readonly 'upload-quota': {
    readonly maxFileBytes: number;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
  };
}
export type SecurityPolicyKind = keyof SecurityPolicies;
export const SECURITY_POLICY_KINDS: readonly SecurityPolicyKind[] =
  Object.freeze([
    'csrf',
    'origin',
    'snapshot',
    'action-authorization',
    'upload-quota',
  ]);
/** Data-only description of a registered policy for diagnostics; never functions. */
export type SecurityPolicyReport = Readonly<
  Record<
    string,
    Readonly<
      Partial<Record<SecurityPolicyKind, Readonly<Record<string, unknown>>>>
    >
  >
>;

const ownerPattern = /^[a-z][a-z0-9._-]{0,63}$/;
function invalid(message: string): never {
  throw new NestvexaError('INVALID_CONFIGURATION', message);
}
function method(value: object, name: string): void {
  if (typeof Reflect.get(value, name) !== 'function')
    invalid(`Security policy requires ${name}()`);
}
function positive(value: unknown, name: string, maximum: number): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    invalid(`Security policy ${name} must be an integer from 1 to ${maximum}`);
}

/** An origin policy allowing exactly one HTTP(S) origin. */
export function exactOriginPolicy(origin: string): SecurityPolicies['origin'] {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    invalid('Origin policy requires an exact HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin
  )
    invalid('Origin policy requires an exact HTTP(S) origin');
  return Object.freeze({
    allowed: (candidate: string | undefined) => candidate === origin,
  });
}

/**
 * Explicit registry of the security policies each feature enforces (CSRF,
 * origin, snapshots, action authorization, upload quotas), keyed by owner
 * (for example `live` or `uploads`). Policies are validated and frozen at
 * registration; evaluation helpers fail closed (a missing policy, a thrown
 * error or a non-boolean result denies). `report()` exposes configuration
 * for devtools without functions or secrets.
 */
@Injectable()
export class SecurityPolicyRegistry {
  readonly #policies = new Map<string, Map<SecurityPolicyKind, object>>();
  #sealed = false;

  register<Kind extends SecurityPolicyKind>(
    kind: Kind,
    owner: string,
    policy: SecurityPolicies[Kind],
  ): void {
    if (this.#sealed)
      throw new NestvexaError(
        'REGISTRY_SEALED',
        'Security policy registry is sealed',
      );
    if (!SECURITY_POLICY_KINDS.includes(kind))
      invalid('Unknown security policy kind');
    if (typeof owner !== 'string' || !ownerPattern.test(owner))
      invalid('Invalid security policy owner');
    if (typeof policy !== 'object' || policy === null)
      invalid('Security policy must be an object');
    const frozen = this.#validate(kind, policy);
    const byKind = this.#policies.get(owner) ?? new Map();
    if (byKind.has(kind))
      throw new NestvexaError(
        'DUPLICATE_REGISTRATION',
        `Duplicate ${kind} policy for ${owner}`,
      );
    byKind.set(kind, frozen);
    this.#policies.set(owner, byKind);
  }
  has(kind: SecurityPolicyKind, owner: string): boolean {
    return this.#policies.get(owner)?.has(kind) === true;
  }
  get<Kind extends SecurityPolicyKind>(
    kind: Kind,
    owner: string,
  ): SecurityPolicies[Kind] {
    const policy = this.#policies.get(owner)?.get(kind);
    if (!policy)
      throw new NestvexaError(
        'UNKNOWN_REGISTRATION',
        `No ${kind} policy for ${owner}`,
      );
    // Registration validated this entry against the same kind.
    return policy as SecurityPolicies[Kind];
  }
  /** Startup assertion that an owner registered every listed kind. */
  require(owner: string, kinds: readonly SecurityPolicyKind[]): void {
    const missing = kinds.filter((kind) => !this.has(kind, owner));
    if (missing.length)
      throw new NestvexaError(
        'UNSUPPORTED_CAPABILITY',
        `${owner} is missing security policies: ${missing.join(', ')}`,
      );
  }
  async verifyCsrf(owner: string, request: object): Promise<boolean> {
    if (!this.has('csrf', owner)) return false;
    try {
      return (await this.get('csrf', owner).verify(request)) === true;
    } catch {
      return false;
    }
  }
  originAllowed(owner: string, origin: string | undefined): boolean {
    if (!this.has('origin', owner)) return false;
    try {
      return this.get('origin', owner).allowed(origin) === true;
    } catch {
      return false;
    }
  }
  async authorize(
    owner: string,
    subject: unknown,
    resource: string,
    action: string,
  ): Promise<boolean> {
    if (!this.has('action-authorization', owner)) return false;
    try {
      return (
        (await this.get('action-authorization', owner).authorize(
          subject,
          resource,
          action,
        )) === true
      );
    } catch {
      return false;
    }
  }
  /** Whether an upload batch fits the owner's quota; no quota denies. */
  uploadAllowed(owner: string, sizes: readonly number[]): boolean {
    if (!this.has('upload-quota', owner)) return false;
    const quota = this.get('upload-quota', owner);
    let total = 0;
    if (!Array.isArray(sizes) || sizes.length > quota.maxFiles) return false;
    for (const size of sizes) {
      if (!Number.isSafeInteger(size) || size < 0 || size > quota.maxFileBytes)
        return false;
      total += size;
    }
    return total <= quota.maxTotalBytes;
  }
  seal(): void {
    this.#sealed = true;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
  report(): SecurityPolicyReport {
    const result = Object.create(null) as Record<
      string,
      Partial<Record<SecurityPolicyKind, Readonly<Record<string, unknown>>>>
    >;
    for (const [owner, byKind] of this.#policies) {
      const entry: Partial<
        Record<SecurityPolicyKind, Readonly<Record<string, unknown>>>
      > = {};
      for (const [kind, policy] of byKind)
        entry[kind] = Object.freeze(
          kind === 'snapshot' || kind === 'upload-quota'
            ? { ...policy }
            : { configured: true },
        );
      result[owner] = Object.freeze(entry);
    }
    return Object.freeze(result);
  }

  #validate(kind: SecurityPolicyKind, policy: object): object {
    switch (kind) {
      case 'csrf': {
        method(policy, 'verify');
        const verify = Reflect.get(policy, 'verify') as (
          request: object,
        ) => boolean | Promise<boolean>;
        return Object.freeze({
          verify: (request: object) => Reflect.apply(verify, policy, [request]),
        });
      }
      case 'origin': {
        method(policy, 'allowed');
        const allowed = Reflect.get(policy, 'allowed') as (
          origin: string | undefined,
        ) => boolean;
        return Object.freeze({
          allowed: (origin: string | undefined) =>
            Reflect.apply(allowed, policy, [origin]),
        });
      }
      case 'action-authorization': {
        method(policy, 'authorize');
        const authorize = Reflect.get(policy, 'authorize') as (
          subject: unknown,
          resource: string,
          action: string,
        ) => boolean | Promise<boolean>;
        return Object.freeze({
          authorize: (subject: unknown, resource: string, action: string) =>
            Reflect.apply(authorize, policy, [subject, resource, action]),
        });
      }
      case 'snapshot': {
        const storage: unknown = Reflect.get(policy, 'storage');
        const ttlMs: unknown = Reflect.get(policy, 'ttlMs');
        if (storage !== 'server' && storage !== 'signed')
          invalid('Snapshot policy storage must be "server" or "signed"');
        positive(ttlMs, 'ttlMs', 86_400_000);
        if (Reflect.get(policy, 'bindsIdentity') !== true)
          invalid('Snapshot policy must bind state to the identity');
        return Object.freeze({ storage, ttlMs, bindsIdentity: true });
      }
      case 'upload-quota': {
        const maxFileBytes: unknown = Reflect.get(policy, 'maxFileBytes');
        const maxFiles: unknown = Reflect.get(policy, 'maxFiles');
        const maxTotalBytes: unknown = Reflect.get(policy, 'maxTotalBytes');
        positive(maxFileBytes, 'maxFileBytes', Number.MAX_SAFE_INTEGER);
        positive(maxFiles, 'maxFiles', 10_000);
        positive(maxTotalBytes, 'maxTotalBytes', Number.MAX_SAFE_INTEGER);
        return Object.freeze({ maxFileBytes, maxFiles, maxTotalBytes });
      }
    }
  }
}
