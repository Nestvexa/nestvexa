# ADR 0002: Versioned Live requests with opaque server-state references

Date: 2026-10-25. Status: **accepted design direction; implementation and acceptance pending**. This record does not advertise a working Live endpoint.

## Decision and boundary

The first Live transport will use a versioned JSON envelope and opaque, cryptographically random server-state reference. The browser may submit only a registered component instance ID, its reference, the expected revision, an allowlisted action ID and bounded public updates/input. It may not choose a class, provider token, template filename, module import or method outside the registration table. Initial rendering is performed through an ordinary authorized Nest route.

The server stores the component definition reference, allowlisted public state, expiry, revision and host-derived owner binding. Binding includes session, principal and tenant; none is taken from request JSON. An anonymous flow needs an explicit host-generated anonymous session identity, rather than an empty owner shared by visitors. The reference is a capability secret in addition to these checks: do not log it, put it in URLs or share rendered private component markup between users. Store references do not make state rendered into HTML confidential.

The protocol's first implementation must reject unsupported protocol majors, unknown fields, unsafe keys, nonfinite numbers, excessive nesting/bytes and invalid action/state paths. Every mutation requires host-verified identity, CSRF, origin policy, content type, payload limits and authorization. Missing policy configuration fails closed. Read/refresh operations still require ownership and authorization; a refresh is not a way to bypass action restrictions.

Dispatch uses explicitly generated Nest controller methods and public decorators, with component/action metadata copied deliberately. Nest runs guards, pipes, interceptors and filters; the framework does not construct guards manually. The scope and ordering proof described in [ADR 0003](0003-nest-execution-pipeline.md) is a blocking prerequisite. Generated handler identity is distinct from the original component method; metadata-sensitive extensions must be tested and documented rather than assumed compatible.

## Alternatives, cost and failures

Signed browser snapshots were rejected for the initial slice: they increase canonicalization/key-rotation surface and still require replay and owner controls. They may become a separately tested capability. A stateless reference without revision storage was rejected because it cannot safely coordinate mutations. Arbitrary RPC dispatch was rejected because it broadens the exposure boundary.

The cost is server storage, expiry cleanup and an explicit scale-out store contract. Memory-store deployments are single-process and lose components on restart. Unknown, expired, revoked or conflicting references return stable public errors with no state disclosure. Actions with uncertain effects must not be transparently retried; see [ADR 0005](0005-state-and-concurrency.md).

## Acceptance evidence

Existing [MVC integration tests](../../tests/integration.test.ts) prove native controller behavior only. Protocol schema/golden vectors, owner/tenant swaps, CSRF, expiry, replay, malformed payloads, unknown actions, real click/update and generated-route scope tests remain required. No Live conformance claim follows from this ADR.
