# ADR 0003: Preserve the host Nest pipeline

Status: accepted for MVC; Live/action strategy requires further implementation and review.

MVC uses normal `@Render`, never a custom method invoker. Express gets a native engine callback. Fastify gets a public `reply.view` decorator consumed by Nest's own HTTP adapter. Configuration rejects a pre-existing Fastify view owner. This retains Nest's actual controller execution rather than reading guard metadata and pretending it executed.

Rejected: replacing every `@Render` with a custom interceptor, or manually calling guards with new instances. These approaches risk ordering, scopes and filter behavior. The public bridge costs two platform integration tests and leaves platform-specific semantics visible.

[Integration tests](../../tests/integration.test.ts) exercise both platforms, request scopes, method guards, pipes, interceptors and prefixes. They do not prove future non-controller Live parity. Generated controller methods or explicit Nest wrappers must be evaluated before exposing Live actions; a metadata-only dispatcher is not accepted.
