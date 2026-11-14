---
'@nestvexa/core': minor
---

Add `NestvexaRegistry` (installed features with their components, safe actions, views,
renderer adapters and capabilities, plus installed plugins). Feature capabilities are
declared in `FeatureCapabilityRegistry` as `<feature>.<capability>`; the registry seals
when the application has bootstrapped. `RequestContextFactory.identity(request)` returns
the frozen kernel principal and tenant, the opt-in `kernelIdentity` source of every
transport. `NestvexaExtensionHost.describe()` lists installed extensions with versions.
The policy contracts gain optional arguments: `csrf.verify(request, subject?, token?)`,
`action-authorization.authorize(subject, resource, action, request?)`, and the
matching `SecurityPolicyRegistry.verifyCsrf(owner, request, subject?, token?)` and
`authorize(owner, subject, resource, action, request?)`. Existing policies keep working.
