import { createHash } from 'node:crypto';

/** Principal resolved by the kernel (never by uploads, never from the browser). */
export interface UploadKernelPrincipal {
  readonly id: string;
  readonly roles?: readonly string[];
}
/** The kernel principal and tenant attached to uploads identities. */
export interface UploadKernelIdentity {
  readonly principal?: UploadKernelPrincipal;
  readonly tenant?: string;
}
/**
 * Structural kernel identity source, for example `RequestContextFactory`
 * from @nestvexa/core (@nestvexa/uploads imports no kernel code).
 * `identity(request)` returns the principal and tenant the host resolved
 * server-side for that request.
 */
export interface UploadKernelIdentitySource {
  identity(request: object): PromiseLike<unknown>;
}
/**
 * Structural view of a kernel feature registry such as `NestvexaRegistry`
 * from @nestvexa/core: uploads declares its feature and capabilities once.
 */
export interface UploadFeatureRegistry {
  registerFeature(feature: {
    readonly name: string;
    readonly package: string;
    readonly capabilities: Readonly<
      Record<
        string,
        | { readonly supported: true; readonly degraded?: string }
        | { readonly supported: false; readonly reason: string }
      >
    >;
  }): void;
}

export function isKernelIdentitySource(
  value: unknown,
): value is UploadKernelIdentitySource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'identity') === 'function'
  );
}
export function isFeatureRegistry(
  value: unknown,
): value is UploadFeatureRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'registerFeature') === 'function'
  );
}

/** A validated copy of a kernel principal/tenant, or undefined when malformed. */
export function kernelIdentityOf(
  value: unknown,
): UploadKernelIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const principal: unknown = Reflect.get(value, 'principal');
  const tenant: unknown = Reflect.get(value, 'tenant');
  if (
    tenant !== undefined &&
    (typeof tenant !== 'string' || tenant.length < 1 || tenant.length > 128)
  )
    return undefined;
  let copy: UploadKernelPrincipal | undefined;
  if (principal !== undefined) {
    if (typeof principal !== 'object' || principal === null) return undefined;
    const id: unknown = Reflect.get(principal, 'id');
    const roles: unknown = Reflect.get(principal, 'roles');
    if (typeof id !== 'string' || id.length < 1 || id.length > 256)
      return undefined;
    if (
      roles !== undefined &&
      (!Array.isArray(roles) ||
        roles.length > 64 ||
        roles.some((role) => typeof role !== 'string'))
    )
      return undefined;
    copy = Object.freeze({
      id,
      ...(roles === undefined
        ? {}
        : { roles: Object.freeze([...(roles as string[])]) }),
    });
  }
  return Object.freeze({
    ...(copy === undefined ? {} : { principal: copy }),
    ...(tenant === undefined ? {} : { tenant }),
  });
}

/**
 * The host binding scoped to the kernel principal and tenant. Snapshots and
 * realtime tokens minted for one user or tenant then never verify for
 * another, even when the host binding (a session) is reused. Identical in
 * @nestvexa/live, @nestvexa/uploads and @nestvexa/realtime.
 */
export function scopeBinding(
  binding: string,
  identity: UploadKernelIdentity,
): string {
  return `nvk1.${createHash('sha256')
    .update(
      // JSON keeps the parts unambiguous whatever characters they contain.
      JSON.stringify([
        'nestvexa-kernel-identity/1',
        binding,
        identity.tenant ?? null,
        identity.principal?.id ?? null,
      ]),
    )
    .digest('base64url')}`;
}
