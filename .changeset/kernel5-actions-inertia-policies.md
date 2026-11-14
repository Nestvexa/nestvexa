---
'@nestvexa/actions': minor
'@nestvexa/inertia': minor
---

Server actions and Inertia register their security policies in the kernel registry.
Actions accept `policies`/`policyOwner` (default `actions`): origin, CSRF (when required)
and action authorization are registered and every decision is the registry's (resource
`group`, action `id` or `id/v<version>`, with the request). With `policies`, a throwing
host `authorize` is a `403 POLICY` denial (the registry fails closed); without it, it is
still a 500. `kernelIdentity` attaches the kernel principal and uses the kernel tenant; a
differing host subject or tenant is `401 IDENTITY_MISMATCH`. `featureRegistry` lists every
action. Inertia gains opt-in `security` (`origin`, `csrfToken`, `authorize`) with
`InertiaSecurityGuard` for unsafe methods (`403 ORIGIN_REJECTED`/`CSRF_REJECTED`) and a
per-page authorization check (`403 PAGE_FORBIDDEN`), `policies`/`policyOwner` (default
`inertia`), `kernelIdentity` (shared `nvIdentity` prop with `authenticated` and `tenant`)
and `featureRegistry`. Without these options both packages behave as before.
