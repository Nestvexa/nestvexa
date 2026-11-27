# An offline-safe form

**Goal:** a support form survives a dropped connection or a closed tab: the
unsent draft is kept on the device and restored, nothing is resent behind the
user's back, the form still works without JavaScript, and signing out clears
everything.

Example: [examples/offline-progressive](../../examples/offline-progressive/README.md)
(port 3122).

## 1. Render an identity-scoped namespace

Drafts are stored under an opaque hash of the identity, so another user of the
same browser never sees them:

<!-- snippet: examples/offline-progressive/src/main.ts -->

```ts
      // Opaque per-identity namespace for local drafts and snapshots.
      draftScope: draftScope(draftSecret, ownerOf(request)),
```

The layout renders it as `<meta name="nv-draft-scope" content="{{draftScope}}" />`.

## 2. Opt fields in

The form carries `data-nv-draft="ticket"` and the server-rendered status
messages (beginning of `views/ticket-form.hbs`); only fields marked `data-nv-draft-field` are stored. The contact email
is not marked, so it never reaches local storage:

<!-- snippet: examples/offline-progressive/views/ticket-form.hbs -->

```hbs
  <form
    id="ticket-form"
    method="post"
    action="/tickets"
    nv:submit="create"
    novalidate
    data-nv-draft="ticket"
    data-nv-draft-message-restored="We restored your unsent draft from this device."
    data-nv-draft-message-interrupted="Not sent. Your draft is saved on this device."
    data-nv-draft-message-reconnected="Connection restored. Reload the page to review your saved draft, then submit again."
    data-nv-draft-committed="{{committedAt}}"
  >
    <p id="ticket-draft-status" data-nv-draft-status role="status"></p>
    <input type="hidden" name="_csrf" value="{{csrf}}" />

    <label for="{{fields.subject.id}}">Subject</label>
    <input
      id="{{fields.subject.id}}"
      name="subject"
      value="{{subject}}"
      maxlength="80"
      nv:model="subject"
      data-nv-draft-field
      aria-invalid="{{fields.subject.ariaInvalid}}"
      aria-describedby="{{fields.subject.errorId}}"
    />
```

After the server accepts the form, the component renders
`data-nv-draft-committed` with a new timestamp, which clears the draft.

## 3. Attach the module and the logout listener

The host serves `@nestvexa/offline` from its own route under `script-src 'self'`
and attaches it:

<!-- snippet: examples/offline-progressive/public/app.js -->

```js
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  // Another tab signing out clears this tab's drafts and snapshots too.
  listenForLogout();
```

The sign-out form carries `data-nv-logout`, so drafts and snapshots are cleared
before the request leaves; the server also sends `Clear-Site-Data`.

## 4. Keep the no-JavaScript path

The form has `method="post" action="/tickets"`. Without JavaScript (or when a
Live component is suspended) it submits natively to a route that runs
`submitForm` from `@nestvexa/forms` with the same validation.

## Security notes

- An interrupted submit is **not** replayed on reconnect. The user reviews the
  restored draft and submits again; Live actions are never retried
  automatically unless the server declares them idempotent.
- Password, file, hidden and payment or one-time-code fields are never stored,
  even when marked.
- For writes that must be sent later, the opt-in `createOfflineQueue` sends only
  server-allowlisted actions declared `idempotent: true`, with an
  `Idempotency-Key`, one tab at a time.

> **Known gap:** no example app wires `createOfflineQueue`; it is shown by the
> test fixtures and the [offline guide](../guides/offline.md#8-opt-in-offline-action-queue)
> only. There is no service worker or background sync.

## Tests

- [tests/browser/offline-progressive.spec.ts](../../tests/browser/offline-progressive.spec.ts):
  draft restore without the email, an offline submit that keeps the draft and
  resends nothing, a read-only offline copy, sign-out clearing, a forged
  sign-out, and accessibility, in three browsers.
- [tests/offline-drafts.test.ts](../../tests/offline-drafts.test.ts): which fields
  are stored and how restoration behaves.
- [tests/offline-queue.test.ts](../../tests/offline-queue.test.ts),
  [tests/offline-queue-server.test.ts](../../tests/offline-queue-server.test.ts)
  and [tests/offline-queue-security.test.ts](../../tests/offline-queue-security.test.ts):
  the action queue.

See also: [offline guide](../guides/offline.md) and the
[forms guide](../guides/forms.md#4-the-same-form-without-javascript).
