# Threat model: initial MVC slice

Assets: private application data, template filesystem boundary, configuration integrity and request isolation. Actors: unauthenticated clients, authenticated users in different tenants, trusted template authors, application operators and dependency maintainers.

Trust boundaries: browser → Nest route (host authentication/validation); controller view model → template rendering (escape by default); view identifier → filesystem (containment); source tree → tarball (allowlisted files); configuration → immutable kernel options (reject unknown keys and accessors). Templates, helpers and installed plugins run as trusted server code, not in a sandbox.

Current tests cover HTML escaping, directory traversal, configuration prototype keys/getters, request scope isolation, native guards and package entries. They do not cover Live snapshots, CSRF mutation endpoints, uploads, Inertia JSON, distributed tenant channels or jobs, since those systems are not implemented. Each remains a blocking requirement.

Read-only trusted template deployments are required. Filesystem mutation by an attacker with server access is outside the application containment guarantee. Host applications must choose authentication, permission checks, request limits, security headers and session policy. See [hardening](hardening.md).
