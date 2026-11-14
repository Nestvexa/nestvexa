/** Principal resolved by the kernel (never by Inertia, never from the browser). */
export interface InertiaKernelPrincipal {
  readonly id: string;
  readonly roles?: readonly string[];
}
/** The kernel principal and tenant attached to Inertia identities. */
export interface InertiaKernelIdentity {
  readonly principal?: InertiaKernelPrincipal;
  readonly tenant?: string;
}
/**
 * Structural kernel identity source, for example `RequestContextFactory`
 * from @nestvexa/core (@nestvexa/inertia imports no kernel code).
 * `identity(request)` returns the principal and tenant the host resolved
 * server-side for that request.
 */
export interface InertiaKernelIdentitySource {
  identity(request: object): PromiseLike<unknown>;
}
/**
 * Structural view of a kernel feature registry such as `NestvexaRegistry`
 * from @nestvexa/core: Inertia declares its feature and capabilities once.
 */
export interface InertiaFeatureRegistry {
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
): value is InertiaKernelIdentitySource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'identity') === 'function'
  );
}
export function isFeatureRegistry(
  value: unknown,
): value is InertiaFeatureRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'registerFeature') === 'function'
  );
}

/** A validated copy of a kernel principal/tenant, or undefined when malformed. */
export function kernelIdentityOf(
  value: unknown,
): InertiaKernelIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const principal: unknown = Reflect.get(value, 'principal');
  const tenant: unknown = Reflect.get(value, 'tenant');
  if (
    tenant !== undefined &&
    (typeof tenant !== 'string' || tenant.length < 1 || tenant.length > 128)
  )
    return undefined;
  let copy: InertiaKernelPrincipal | undefined;
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
