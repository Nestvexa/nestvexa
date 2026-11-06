# Offline and progressive support desk

A Nest (Express) app with one support-ticket form that works in three
situations:

- **Without JavaScript.** The Live component's markup is a real form
  (`method="post" action="/tickets"`, `name` attributes, hidden `_csrf`).
  `POST /tickets` runs `submitForm` from `@nestvexa/forms`: CSRF and origin
  checks, input hardening and the same Zod schema as the Live action. Errors and
  old input come back through the session (read once) and the page answers with
  `303` (post/redirect/get), so a reload never resubmits. A `<noscript>` note
  says which features need JavaScript.
- **With JavaScript.** The form is a Live component (`nv:submit="create"`,
  deferred `nv:model`). Validation errors are rendered next to the fields with
  an error summary; focus moves to the first invalid field.
- **With an unreliable network.** `@nestvexa/offline` adds:
  - **Local drafts** of the subject, details and priority fields, namespaced by
    an HMAC of the session identity (`draftScope`). The contact email is not
    marked `data-nv-draft-field`, so it is never written to the device. A
    reload restores the draft and announces it in a `role="status"` element.
  - **Interrupted submits.** A Live request that fails with `NETWORK` keeps the
    draft and shows "Not sent. Your draft is saved on this device." When the
    browser reports `online`, only the message changes. Nothing is retried or
    replayed: the Live client suspends a component after a transport failure
    (its server state is unknown), so the message asks the user to reload.
    The reload restores the draft from the device, and the user submits again.
  - **`nv:offline`** shows an advisory connection hint inside the component.
  - **A read-only snapshot** of "Your recent tickets". The region is remembered
    in session storage; "Refresh tickets" calls `loadRegion`, and when the fetch
    fails because the network is down it shows an inert, labelled copy with its
    save time. HTTP errors never fall back to the copy.
  - **Sign out clears this device.** The sign-out form carries
    `data-nv-logout`, which clears every draft and snapshot synchronously on
    submit and tells other tabs. The response also sends
    `Clear-Site-Data: "storage"` as defense in depth.

## Run

From the repository root: `pnpm install`, `pnpm build`, then

```sh
pnpm --filter @nestvexa/example-offline-progressive start   # http://127.0.0.1:3122
```

`PORT` overrides the port. There are no other settings. Try it: type a ticket,
reload, switch the browser's network panel to offline and submit, go back
online, reload and submit again; or disable JavaScript and use the same form.

## Tests

[`tests/browser/offline-progressive.spec.ts`](../../tests/browser/offline-progressive.spec.ts)
runs in Chromium, Firefox and WebKit against the example (root suite port
**3122**): draft restore after reload without the email or CSRF token, an
offline submit that is never resent after reconnecting (requests are counted
before and after the reload), the labelled inert snapshot while offline, sign
out clearing drafts and snapshots before the request is sent, a forged sign-out
refused with `403`, the full no-JavaScript validation and post/redirect/get
flow, and axe scans with and without validation errors.

## Security notes

- Drafts live in `localStorage`, readable by any script on this origin. The
  strict CSP (`script-src 'self'`, no inline script) and the opt-in field list
  are the protection; never mark passwords, tokens or payment fields (the
  module refuses the obvious ones even when marked).
- The draft namespace is an opaque hash, not an authenticator. The demo secret
  is random per process, so drafts are orphaned on restart; production loads a
  stable secret of at least 32 bytes from its secret store.
- Snapshots are sanitized when stored and again when restored, carry no Live
  snapshot, CSRF token or form target, and expire with the tab.
- There is deliberately no offline action queue. Submits are explicit user
  actions validated by the server like any other request.
- Sessions are an in-memory guest demonstration. Production needs real
  authentication, a persistent session store and HTTPS-only cookies.

## Known gaps

- No service worker: reloading while offline shows the browser's offline page.
- Conflict handling is "review and submit again"; there is no merge UI.
- Tickets are stored in process memory per guest session.
