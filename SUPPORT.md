# Support

Nestvexa is an implementation preview (`0.1.0-alpha.*`) with no production
support promise. After 1.0, the support windows in the
[versioning and deprecation policy](docs/release/versioning-and-deprecation.md)
apply: the latest minor of the current major receives fixes, and the previous
major receives security fixes for 6 months after a new major.

## Getting help

Use the repository's GitHub issues for reproducible bugs and documentation
gaps, and discussions (once enabled by the owner) for questions. Include:

- Nestvexa package versions (all `@nestvexa/*` should match), Node, pnpm/npm,
  NestJS and TypeScript versions, OS, browser and HTTP adapter (Express or
  Fastify);
- a minimal reproduction (a repository or the smallest failing test);
- expected and actual behavior, and sanitized logs.

Never post credentials, session cookies, CSRF tokens, Live snapshot tokens,
upload tokens or customer data. Vulnerabilities go through the private process
in [SECURITY.md](SECURITY.md), never public issues.

## Scope

Supported: the documented public API of published packages on the tested
Node/Nest/browser matrix. Not supported: imports from package internals,
unreleased branches, modified tarballs, and hosting/infrastructure questions
beyond the [hardening guide](docs/security/hardening.md).
