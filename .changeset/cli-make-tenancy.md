---
'@nestvexa/cli': minor
---

Add `nestvexa make:tenancy`, a multi-tenant starter generator. After `init` it
writes server-side tenant resolution (`resolvePrincipal`/`resolveTenant` from the
session only, re-checked against a membership rule on every request), registers it
as the kernel `requestContext` with `kernelIdentity: true` on Live so snapshots are
bound to the user and tenant, and adds a tenant-scoped `tenant-notes` Live
component, a CSRF-checked tenant selection page at `/tenancy` and an isolation test.
