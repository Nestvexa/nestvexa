---
'@nestvexa/offline': minor
---

Add an opt-in offline action queue for operations the server declares
idempotent. `offlineActionAllowlist`, `offlineServerAction` and
`createOfflineReplayGuard` (`@nestvexa/offline/server`) declare queueable
routes and execute each replayed request ID at most once per identity;
`createOfflineQueue` and `attachOfflineQueue` store bounded, expiring,
identity-scoped entries without secrets, replay them in order with the same
request ID, and render an accessible, translatable status region and list
with Discard and Try again. Logout also clears queued entries.
