# URL and session state

`@Url()` and `@Session()` extend an explicitly declared `@State` field. They do not select a component, action, identity, or template from browser input. URL values remain public, and session fields are still public component state when rendered or returned to the browser. Store confidential data in a host-owned provider instead.

```ts
import { LiveComponent, State, Url, Session, Action } from '@nestvexa/live';

@LiveComponent({ name: 'catalog', view: 'catalog' })
export class Catalog {
  @Url({ key: 'q', except: '' })
  @Session({ ttl: 1_800_000 })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 100,
  })
  query = '';

  @Url({ history: 'push', except: 1 })
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1,
  })
  page = 1;

  @Action()
  reset() {
    this.query = '';
    this.page = 1;
  }
}
```

The host must configure its normal session middleware before mounting a component that uses `@Session`. Nest documents separate [Express and Fastify session integrations](https://docs.nestjs.com/techniques/session). Nestvexa expects a writable `request.session` object; it does not create a session, configure cookies, persist a middleware store, or save a provider's session on the host's behalf. Cookie encryption, TLS, session revocation, store availability, and concurrent session-write behavior remain host responsibilities. A missing session object fails with `SESSION_REQUIRED` (503).

## Mount precedence and validation

The runtime loads initial session values, then applies explicitly present query values, before mount hooks. The query string wins when a field has both decorators. Action requests restore their existing component snapshot; they do not rehydrate state from the action endpoint's query string.

Every restored value passes the field's `State.validate` callback. All candidate values are checked before any field is assigned. A failed validator produces `STATE_VALIDATION` (422). Validators must remain pure: validation cannot undo a validator's own external effects. DTO/action validation remains separate and authoritative.

URL fields require `writable: true` because the query string is untrusted input. Initialized strings, finite numbers, and booleans are supported. Numbers use JSON-style decimal syntax; booleans accept exactly `true` or `false`. Empty strings remain strings. Null, arrays, objects, dates, and ambiguous coercion are rejected for URL state. `except` must have the same primitive type as the initialized field.

Only registered aliases are read. Duplicate values for a registered key, malformed UTF-8 or percent escapes, malformed request paths, more than 128 query pairs, or a request URL larger than 8 KiB produce `INVALID_URL_STATE` (422). Unrelated query parameters do not become state. Aliases use an ASCII letter followed by at most 63 letters, digits, underscores, or hyphens. Prototype-related names are forbidden. Duplicate aliases and missing `@State` pairing fail at component registration. Each component permits at most 64 URL fields and 64 session fields.

The parser uses Node's [WHATWG URL and URLSearchParams APIs](https://nodejs.org/api/url.html#class-urlsearchparams), with additional input validation. Unicode query values are supported. Rendering still follows the normal escaping rules; URL state never grants trusted HTML status.

## History effects

`history` defaults to `replace`. `push` requests a history entry when an accepted server value changes. `except` removes that key instead of serializing the matching value. Effects contain only the registered key, a string or removal marker, and the declared history mode. The browser updates the current document's query parameters; the server cannot supply an arbitrary URL through this API. Each effect collection is limited to 8 KiB.

History bookkeeping does not authorize requests. The server rechecks ownership, CSRF, origin, action policy, and revision as usual. Do not place access tokens, passwords, confidential search data, or session identifiers in URL fields. Query strings may enter browser history, reverse-proxy logs, referrers, bookmarks, and analytics.

## Session persistence and isolation

`Session.ttl` is measured in milliseconds. The default is 30 minutes; supported values are integers from 1 to 86,400,000. The host persists the session after a successful component mount/action/render. Expired records are ignored. No automatic action retry occurs.

Storage keys include the component name, the configured field alias, and a SHA-256 digest of the host's authoritative identity binding. The binding must already include all relevant user, session, and tenant identity. A different binding cannot restore an older binding's state, even when both appear in the same middleware session object. A client-supplied tenant or user field never replaces this binding. Digesting a binding is namespacing, not encryption or authentication of the session store.

Fields with the same alias in two instances of the same component intentionally share a remembered session value. Their live snapshots remain independent. Two tabs can overwrite the remembered value according to the host session store's concurrency rules; use an application transaction or a dedicated versioned store for business records. Session persistence is not a payment/order idempotency mechanism.

Session records contain detached, bounded JSON. Object prototypes, getters, classes, sparse arrays, cyclic values, and prototype-pollution keys are rejected by the existing Live serializer. Values are cloned again when restored, so mutating an instance cannot mutate its stored record. Persistence validates the complete collection before writing any ordinary session fields. Custom proxies and external store failures may still fail during host persistence; the host must surface those failures and define its own atomicity policy.

Session middleware owns session expiration and garbage collection. Changing the authoritative binding leaves older namespaced records inaccessible until the middleware session expires or the host clears them. Applications that allow frequent tenant changes should cap session size and clear obsolete Nestvexa fields in their session lifecycle. Nestvexa does not scan or delete unrelated application session data.

## Compatibility and evidence

These are original Nestvexa semantics, inspired by [Livewire's URL behavior](https://livewire.laravel.com/docs/4.x/url), with a separate TypeScript/Nest implementation. They do not implement Livewire's wire protocol or accept its attribute expressions.

The helper's parsing, inheritance, strict schemas, aliases, malformed requests, atomic validation, TTL, cloning, identity/component separation, missing middleware, and unsafe session data are tested in [live-state-context.test.ts](../../tests/live-state-context.test.ts). Real Nest HTTP tests exercise Express and Fastify in [live-state-context-integration.test.ts](../../tests/live-state-context-integration.test.ts), including guards, CSRF, session writes, snapshot isolation, failure revocation, and action-query rejection. That fixture attaches a host-owned session bag through its identity resolver; it does not certify a production session provider's persistence behavior. Run `pnpm exec vitest run tests/live-state-context.test.ts tests/live-state-context-integration.test.ts`. Browser acceptance and release readiness are tracked separately in the [feature ledger](../implementation/feature-ledger.md).
