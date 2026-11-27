# Scope every request to one tenant

**Goal:** a signed-in user works in one tenant (workspace) at a time, and MVC
pages, Live components, server actions, uploads, realtime and Inertia all see the
same verified user and tenant. Nothing the browser sends can choose the tenant.

Example: [examples/multi-tenant](../../examples/multi-tenant/README.md) (port 3119).

## 1. Guard the tenant routes

A plain Nest guard resolves the `:tenant` route parameter against the user's
memberships before the handler reads anything: `401` for guests, `403` for
non-members.

<!-- snippet: examples/multi-tenant/src/tenancy.ts -->

```ts
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(Directory) private readonly directory: Directory) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const slug = request.params?.['tenant'];
    if (typeof slug !== 'string') throw new ForbiddenException();
    this.directory.accessTo(request, slug);
    return true;
  }
}
```

The guarded page then records the active tenant in the **server-side session**;
Live requests (which have no `:tenant` parameter) read it from there and re-check
the membership on every call.

## 2. One binding for every transport

`requestContext` in `src/context.ts` builds one binding from the session:
`user:<id>:tenant:<slug>:role:<role>:session:<sid>`. Each transport's identity
resolver is derived from it, so a Live snapshot, an upload token or a realtime
subscription minted in one tenant never works in another:

<!-- snippet: examples/multi-tenant/src/context.ts -->

```ts
/** Live: snapshots are bound to the full binding. */
export function liveIdentity(
  directory: Directory,
  request: object,
): LiveIdentity {
  const context = required(directory, request);
  return { binding: context.binding, csrfToken: context.csrfToken };
}
```

Data access takes the tenant as an argument and filters by it
(`ProjectRepository` in `src/tenancy.ts`). Realtime channels are named per tenant
(`tenant:<slug>:projects`) and authorized against the same membership check, and
cache keys include the tenant.

Instead of wiring each resolver by hand, the kernel can supply one principal and
tenant to every transport: pass `requestContext: { resolvePrincipal, resolveTenant }`
in the kernel registration, set `kernelIdentity: true` in the Live registration and
pass the `RequestContextFactory` as `kernelIdentity` to the other modules (see "One user and tenant across transports"
in the [core README](../../packages/core/README.md)).

## Security notes

- Re-check membership on every request, not only at sign-in: a revoked member
  loses access to Live actions and realtime channels immediately.
- Admin-only actions are refused by the Live `authorize` policy for members, even
  when a member forges the request (`authorizeLive` in `src/app.ts`).
- Island props are signed by the server and refused when they come from another
  tenant.

## Tests

- [tests/multi-tenant-isolation.test.ts](../../tests/multi-tenant-isolation.test.ts):
  MVC, REST, Live, Inertia, server actions, islands, uploads, realtime and cache
  each refuse another tenant's data; tenant switching invalidates snapshots.
- [tests/browser/multi-tenant.spec.ts](../../tests/browser/multi-tenant.spec.ts):
  cross-tenant pages and API, replayed snapshots and a forged admin action in
  three browsers.
- [tests/kernel-transports.test.ts](../../tests/kernel-transports.test.ts): the
  kernel principal and tenant across transports.

See also: [security guide, tenant isolation](../security/guide.md#tenant-isolation)
and [multi-tenancy](../guides/auth-and-data.md#multi-tenancy).
