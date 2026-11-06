# nv:confirm

Add static plain-text confirmation to a same-element `nv:click`, `nv:submit` or
`nv:keydown` binding. It changes presentation only; the server must still authorize
every action and validate ownership, CSRF and input.

```hbs
<button type='button' nv:click='remove' nv:confirm='Remove this sample item?'>
  Remove item
</button>
<form nv:submit='save' nv:confirm='Save these changes?'>
  <label for='title'>Title</label>
  <input id='title' nv:model='title' value='{{title}}' />
  <button type='submit'>Save</button>
</form>
```

The default handler calls native `window.confirm` with the literal attribute
value. No client-side interpolation, HTML interpretation, action arguments or JavaScript
evaluation is added. Use one unmodified declaration, with 1–1,024 UTF-16 code
units, nonblank text and no C0/DEL controls except tab/newline/carriage return.
Unicode and RTL messages are accepted. `nv:confirm.prompt`, `.html` and other
modifiers fail explicitly. For HTML escaping, continue using ordinary escaped
HBS interpolation when composing a message from host data.

Event key/self/disabled filters run first. A matching confirmed event prevents
its native default even if it is canceled, pending or suppressed by `.once`.
Debounce/throttle still run before opening the prompt. `.once` is consumed on the
approval **attempt**, including cancellation or provider failure; omit it if the
user should be able to try again. Existing enhanced forms always prevent native
submission. Use a form-level confirmation for `nv:submit`; use `type="button"`
for a separate `nv:click` action inside a form.

No HTTP request or request-loading state begins before approval. Only literal
boolean `true` approves. Cancellation preserves local drafts and does not advance
the revision. Approval uses the current snapshot and drafts at dispatch, not a
state captured before the question. Independent already-running work can still
complete; confirmation is not a transaction, consent record or idempotency key.
Programmatic `client.call`/Alpine calls do not interpret DOM confirmation markup.

Pending repeats on the same element are suppressed. At most 16 approvals can be
pending per client. The approval deadline defaults to 30 seconds; configure
`confirmationTimeoutMs` as an integer from 1 through 300,000. Timeout cancels
without sending a request. A blocking native prompt cannot be forcibly closed
by JavaScript timers; an expired result is rejected once control returns. Browsers
may suppress native dialogs, in which case their false result declines the action.
See the [HTML user-prompt contract](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#dom-confirm-dev).

Removal, explicit disposal, ownership/marker changes, directive reconfiguration,
disabled targets, explicit hidden/inert attributes and uncertain component transport failures cancel
pending approval. Late answers cannot act on a new registration after remount.
A custom provider receives an aborted signal and must clean up its own UI; an
uncooperative promise cannot keep the framework approval slot pending forever.
No automatic retry occurs. Nonboolean results, thrown errors and rejected
providers fail closed with a redacted error; implementation exception text is
not forwarded. A later explicit attempt remains possible unless `.once` consumed it.

## Custom asynchronous dialogs

Manual application entries can provide a typed callback:

```ts
import { createLiveClient } from '@nestvexa/client';
import type { LiveConfirm } from '@nestvexa/client';

const confirm: LiveConfirm = ({ message, signal }) =>
  new Promise<boolean>((resolve, reject) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const dialog = document.createElement('dialog');
    const title = document.createElement('h2');
    title.id = 'confirm-' + crypto.randomUUID();
    title.textContent = 'Confirm action';
    const text = document.createElement('p');
    text.id = title.id + '-message';
    text.textContent = message;
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.setAttribute('aria-describedby', text.id);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.autofocus = true;
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    cancel.addEventListener('click', () => dialog.close('cancel'));
    approve.addEventListener('click', () => dialog.close('approve'));
    const abort = () => {
      if (dialog.open) dialog.close('cancel');
    };
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      dialog.remove();
    };
    dialog.addEventListener(
      'close',
      () => {
        cleanup();
        resolve(dialog.returnValue === 'approve');
      },
      { once: true },
    );
    signal.addEventListener('abort', abort, { once: true });
    dialog.append(title, text, cancel, approve);
    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

const client = createLiveClient({ confirmationTimeoutMs: 30_000, confirm });
client.mount();
```

This is an unstyled host entry pattern, not a shipped modal UI kit. Configure
`browser.mode: 'manual'` as described in [default setup](../guides/default-live-setup.md)
when replacing automatic startup; do not mount competing clients.
The frozen context contains `element`, `action`, `message` and `signal`, without
copying tokens or state into a diagnostic payload. The callback is trusted host
code with browser privileges. Render `message` via `textContent`, use an accessible
modal/alert dialog, focus the appropriate cancel/approval control, support Escape,
prevent background interaction, return focus on close, and remove resources when
the signal aborts. Use unique accessible labels for concurrent dialogs or manage
your own dialog queue. Follow the [WAI alert-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/).
The automatic umbrella boot uses the native default; it does not silently install
an application dialog callback.

## Combinations

The [directive matrix](directive-matrix.md) proves these combinations in Chromium:
approved/denied `nv:click`, a denied `nv:submit` that still prevents native
submission, a link whose navigation stays prevented even when approved, keyboard
`nv:keydown.enter` approval, and `nv:confirm` with `nv:optimistic` plus a targeted
loading effect on one control. With `.once`, the single invocation is consumed by
the attempt: a denied dialog does not leave a second chance, matching the rule that
`.once` never retries an action that may have run. Use a plain binding when a
denied confirmation must allow another try.

## Evidence and compatibility

[Controlled Chromium tests](../../tests/client-confirmation.test.ts) exercise
async approval, an actual accessible `<dialog>` with keyboard cancellation and
axe, literal text/XSS boundaries, cleanup, deadlines, capacity, failures and newer
drafts. [Real Nest browser tests](../../tests/browser/confirmation.spec.ts) exercise
native cancellation/keyboard approval, one authorized mutation, an empty-list
round trip, direct requests and cross-session/CSRF rejection in all three engines.
Native browser chrome and manual assistive-technology behavior are not certified
by axe. The example action changes only session-bound public seed data.

This additive alpha directive and optional client settings add no Live wire
fields, server-side confirmation claim, package or runtime dependency. The server
cannot infer that the browser displayed or accepted a prompt. Remaining Phase 4
directives, renderer integrations and the full release matrix remain separate work.
