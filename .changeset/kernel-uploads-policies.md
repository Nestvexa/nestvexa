---
'@nestvexa/uploads': minor
---

Add the structural `policies` and `policyOwner` options: uploads registers its origin,
CSRF, authorization and `upload-quota` policies in a kernel policy registry (for example
`SecurityPolicyRegistry`) and enforces origin, CSRF-header and authorization decisions
through it. Host `authorize` callbacks must return a literal `true`.
