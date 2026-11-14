---
'@nestvexa/live': minor
'@nestvexa/uploads': minor
'@nestvexa/realtime': minor
---

Opt-in kernel identity and feature registration. `kernelIdentity` (structural, for example
`RequestContextFactory`) attaches the kernel `principal` and `tenant` to the identity every
host policy receives, scopes the Live, uploads and realtime bindings to them and fails
closed (`401 IDENTITY_REQUIRED`) on a failing kernel identity or, for uploads, a host
tenant that differs from the kernel tenant. Nothing changes without the option.
`featureRegistry` (for example `NestvexaRegistry`) receives each package's feature and
capabilities. The uploads multipart `_csrf` field is now decided by the registered CSRF
policy (through the kernel registry when `policies` is configured) instead of a direct
comparison; accepted and rejected forms are unchanged. `RealtimeService.identity(request,
resolver)` is the identity the hub sees.

Migration: when Live signs realtime tokens, enable `kernelIdentity` on both Live and
realtime or on neither, because scoped bindings only match each other. With
`kernelIdentity`, `RealtimeService.revoke(binding)` takes the scoped binding the hub sees
(`identity.binding` in `authorizeChannel`).
