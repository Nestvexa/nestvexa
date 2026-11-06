---
'@nestvexa/live': minor
'@nestvexa/client': minor
'nestvexa': patch
---

- Live: `LiveEvents.publish(channel, name, payload)` pushes `@OnEvent` domain
  events through a structural publisher (`events`, or `realtime` with
  `publish`, such as `RealtimeService`); subscribed browsers run the listener
  action through the normal authorized pipeline.
- Live: `assetVersion` stamps component roots and rejects stale clients with
  `409 ASSET_VERSION_MISMATCH` plus `x-nestvexa-reload: asset-version`; the
  client dispatches a cancelable `nestvexa:reload` event and reloads.
- Live: `@Reactive` fields are read-only during child hooks and actions; a
  write fails with `409 REACTIVE_PROP_MUTATED` at the statement, before later
  side effects run.
- Client: a request not sent because the browser is offline, and a `$sync`
  without a response, no longer suspend the component (actions that may have
  reached the server still do).
- Client: focus follows a refreshed child root to the same element, so
  focus-first-invalid survives a parent refresh after a nested form submit.
