# Offline drafts, read-only snapshots and safe reconnect

`@nestvexa/offline` is an optional browser module for three progressive
behaviours. It never queues or replays actions. The server stays
authoritative, and every submit is an explicit user action.

| Behaviour          | What the user sees                                                    | What never happens                         |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------ |
| Local drafts       | Typed values come back after a reload or crash, with a status message | Unmarked or sensitive fields being stored  |
| Interrupted submit | "Not sent. Your draft is saved on this device."                       | Automatic resubmission when back online    |
| Read-only snapshot | The last loaded region, inert, labelled with its save time            | A stale Live snapshot or CSRF token mounts |

It complements the core advisory indicator
[`nv:offline`](../reference/nv-offline.md), which shows connectivity hints
inside a component. Install details and every option are in the
[package README](../../packages/offline/README.md).

## 1. Render an identity-scoped namespace

Drafts are stored under an opaque hash of the current identity, so another
user on the same browser never sees them and logout can clear everything.

```ts
import { draftScope } from '@nestvexa/offline/server';

@Get('products')
@Render('products')
async products(@Req() request: SessionRequest) {
  return {
    draftScope: draftScope(draftSecret, `session:${request.sessionID}`),
    widget: await this.live.mount(ProductForm, request),
  };
}
```

```hbs
<meta name='nv-draft-scope' content='{{draftScope}}' />
```

Use a stable binding (user ID or session binding) and a secret of at least
32 bytes. Rotating the secret orphans old drafts; they expire or are purged.

## 2. Opt the form in, field by field

```hbs
<form
  data-nv-draft='product'
  data-nv-draft-message-restored='{{t "drafts.restored"}}'
  data-nv-draft-message-interrupted='{{t "drafts.interrupted"}}'
  data-nv-draft-message-reconnected='{{t "drafts.reconnected"}}'
  {{#if committedAt}}data-nv-draft-committed='{{committedAt}}'{{/if}}
  nv:submit='create'
>
  <p data-nv-draft-status role='status'></p>
  <label>Name <input name='name' nv:model='name' data-nv-draft-field /></label>
  <label>Price
    <input name='price' nv:model='price' inputmode='decimal' data-nv-draft-field />
  </label>
  <label>Contact email <input name='email' type='email' nv:model='email' /></label>
  <button type='submit'>{{t "products.create"}}</button>
</form>
```

- Only `name` and `price` are stored. The email field is not marked, which is
  the "no PII by default" rule. Password, file and hidden inputs and payment
  or one-time-code autocomplete fields are never stored, even when marked.
- Use the default (deferred) `nv:model`. Restoration dispatches `input` and
  `change`, which marks deferred fields dirty without sending a request. A
  `.live` model would synchronize state as it does for typing; that is a
  model update, never an action.
- Messages come from the server, so they can be translated with
  [`@nestvexa/i18n`](i18n.md).

## 3. Tell the module when the server accepted the form

After a successful action, render `data-nv-draft-committed` with an
epoch-millisecond timestamp. A changed token clears the draft. On a reload,
a token only clears drafts saved before it, so a newer draft survives.

```ts
@Action() create(): void {
  // …validate and persist through your service…
  this.committedAt = Date.now();
  this.name = '';
  this.price = '';
}
```

For forms without server markup, call `markCommitted(form)` from your own
code after the request succeeds.

## 4. Serve and attach the module

Serve `@nestvexa/offline/dist/index.js` from an explicit route under
`script-src 'self'`, then attach it from your own module:

```ts
import {
  attachOfflineDrafts,
  createDraftStore,
  createSnapshotCache,
  listenForLogout,
  loadRegion,
} from '/assets/offline.js';

const scope = document
  .querySelector('meta[name="nv-draft-scope"]')
  ?.getAttribute('content');
if (scope) {
  attachOfflineDrafts(document, { store: createDraftStore({ scope }) });
  listenForLogout();
  const activity = document.getElementById('recent-activity');
  const refresh = document.getElementById('refresh-activity');
  const cache = createSnapshotCache({ scope });
  refresh?.addEventListener('click', () => {
    if (activity)
      void loadRegion(activity, '/admin/activity', {
        cache,
        key: 'activity',
        label: refresh.dataset['offlineLabel'] ?? 'Offline copy',
      });
  });
}
```

## 5. The reconnect flow

1. The user submits while the network is down. The Live client reports a
   `nestvexa:error` with code `NETWORK` or `TIMEOUT` from the component.
2. The module keeps the draft, sets `data-nv-draft-state="interrupted"` and
   announces the interrupted message in the form's status element.
3. When the browser fires `online`, only the message changes ("Connection
   restored. Review and submit again."). Focus stays where it is.
4. The user reviews the values and presses submit again. Whether that works
   without a reload depends on what the client knows about the failed request:
   - **Not sent.** The browser reported itself offline (`navigator.onLine` was
     `false`), so the client never sent the request. The component stays
     usable; resubmitting after reconnect works without a reload.
   - **A refresh (`$sync`) without a response.** No action method runs on a
     refresh, so the component stays usable; unacknowledged field values stay
     dirty and travel with the next request.
   - **An action without a response while the browser believed it was
     online** (dropped connection, `TIMEOUT`). The action may have run on the
     server, so the component is suspended: further actions are rejected until
     the page reloads or the host remounts the component from authoritative
     markup. Drafts survive the reload.

   In every case the server validates the new request like any other. If an
   earlier request did commit, its revision makes the retry fail with
   `409 STALE_REVISION` (the component then suspends) instead of running the
   action twice.

There is no offline action queue. Purchases, payments and deletes are never
replayed on reconnect.

## 6. Logout clears drafts

```hbs
<form method='post' action='/logout' data-nv-logout>
  <button>{{t 'auth.logout'}}</button>
</form>
```

Submitting this form clears every draft (all scopes) and every snapshot in
this tab synchronously, broadcasts to other tabs (`BroadcastChannel` with a
storage-event fallback) and dispatches `nestvexa:logout`. Pages that called
`listenForLogout()` clear their own session-storage snapshots. For defense in
depth, the logout response can also send `Clear-Site-Data: "storage"`
(`clearSiteDataHeader` from `@nestvexa/offline/server`); browser support is
uneven, so do not rely on it alone.

## 7. Testing offline with Playwright

```ts
test('keeps the draft and never replays the submit', async ({
  page,
  context,
}) => {
  await page.goto('/admin/products');
  await page.getByLabel('Name').fill('Desk lamp');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('status')).toContainText('Not sent');
  await context.setOffline(false);
  // The submit was never sent (the browser was offline), so the component is
  // still usable; a reload is not required. The draft also survives one.
  await page.reload();
  await expect(page.getByLabel('Name')).toHaveValue('Desk lamp');
  // The server has not created the product until the user submits again.
});
```

The package's own suites run in real Chromium with a strict CSP:
[drafts](../../tests/offline-drafts.test.ts) and
[snapshots](../../tests/offline-snapshot.test.ts).

## Limits

- No service worker: a full page reload while offline is not supported.
- Snapshots live in session storage (per tab) for at most 24 hours.
- Conflict handling is "review and submit again"; there is no merge UI.
- Local storage is readable by any script on the origin. Keep a strict CSP and
  never mark secrets as draft fields.
