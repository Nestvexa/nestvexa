# nv:poll

Call an explicitly registered action periodically while the document is visible
and the browser reports an online connection:

```hbs
<section nv:poll.5s='refresh'>
  <p role='status'>{{message}}</p>
  <button type='button' nv:click='refresh'>Refresh now</button>
</section>
```

`nv:poll='refresh'` defaults to **2,500 milliseconds**. The only interval
modifiers are an integer number of milliseconds (`.1500ms`) or seconds (`.5s`),
from **1,000 through 3,600,000 milliseconds** inclusive. Leading zeroes,
fractions, duplicate interval modifiers, `.keep-alive`, `.window` and arbitrary
JavaScript expressions are errors. The value is a simple action identifier;
`refresh()`, dotted paths and reserved object names are rejected.

## Scheduling and cleanup

The first call occurs after the interval. A slow invocation never overlaps
another invocation from the same binding. Its next interval begins after
completion. Failures double the delay up to six times, capped at one hour;
a successful invocation resets the original interval. These are subsequent
explicit polling attempts, not retries within the action transport. A component
suspended by an uncertain mutation outcome cannot keep polling.

Hidden documents and browsers reporting `navigator.onLine === false` pause
timers. Resuming starts a full interval, without a catch-up burst. Online status
is advisory: it cannot prove that a server is reachable. Server rate limits and
authorization apply independently of this client scheduling policy. Choose a
reasonable interval for backend cost, especially when many users open many tabs.

Repeated discovery of a retained binding preserves its timer. Detaching the
element, changing its action/modifier, moving it to another component, handing
the subtree to an island or whole-ignore owner, revoking its Live registration,
and disposing the client release scheduled work. A native disabled control skips
that tick. Changed declarations are validated before a new binding is started.
There is a default capacity of **256 observer bindings per mounted client**, with
a validated manual `maxObservers` option from 1 through 1,000. Poll and
intersection declarations both count toward that capacity. This bounds client
resources; it does not replace server quotas.

## Security and fallback

Polling uses the ordinary registered action queue and protected Nest route. It
does not select arbitrary methods or bypass guards, validation, CSRF, session,
tenant, revision or origin checks. Use read-only refresh actions. Periodic calls
are unsuitable for purchases, deletes or other irreversible effects. A polling
declaration cannot share its element with `nv:confirm`; automatic work cannot
bypass a consent prompt. Confirmation remains a UI affordance, not authorization.

Whole-ignore and framework-island descendants are excluded; nested Live roots
have their own registrations. Without JavaScript, initial server HTML and an
ordinary refresh link/form remain available. Polling itself supplies no no-JS
action route or offline cache.

The [browser corpus](../../tests/client-observers.test.ts) exercises real Chromium
timers, offline transitions, hidden-document scheduling, non-overlap, backoff,
capacity and ownership cancellation. See the current implementation report for
which integration and cross-browser gates have actually run. This additive alpha
directive introduces no Live wire-version change.

Platform contracts: [HTML page visibility](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility)
and [browser online state](https://html.spec.whatwg.org/multipage/system-state.html#navigator.online).
