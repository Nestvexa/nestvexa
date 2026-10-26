# ADR 0003: Preserve the host Nest pipeline

Status: accepted for MVC; Live/action strategy requires further implementation and review.

Implementation update, 2026-10-26: the initial Live slice now generates actual Nest controllers with public decorators and copied class/method/parameter metadata. Components resolve through each registration's `ModuleRef`, with an application-local request-context registry. [Live pipeline tests](../../tests/live.test.ts) and [registration tests](../../tests/live-registration.test.ts) exercise Express/Fastify guards, pipes, interceptors, filters, scopes, ownership, collisions and shutdown races. Custom code observes the generated controller in `ExecutionContext`; complete parity across all Nest integrations remains an open release requirement.

MVC uses normal `@Render`, never a custom method invoker. Express gets a native engine callback. Fastify gets a public `reply.view` decorator consumed by Nest's own HTTP adapter. Configuration rejects a pre-existing Fastify view owner. This retains Nest's actual controller execution rather than reading guard metadata and pretending it executed.

Rejected: replacing every `@Render` with a custom interceptor, or manually calling guards with new instances. These approaches risk ordering, scopes and filter behavior. The public bridge costs two platform integration tests and leaves platform-specific semantics visible.

[Integration tests](../../tests/integration.test.ts) exercise both platforms, request scopes, method guards, pipes, interceptors and prefixes. They do not prove future non-controller Live parity. Generated controller methods or explicit Nest wrappers must be evaluated before exposing Live actions; a metadata-only dispatcher is not accepted.
