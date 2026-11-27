# nv:model

Bind a native form control to a writable public state field. Edits stay local drafts until an action sends them, unless a modifier asks for independent synchronization:

```hbs
<label for='search'>Search</label>
<input id='search' nv:model.live.debounce.300ms='query' />
```

## Syntax and modifiers

The value is a public state field or a dotted path of at most eight identifier segments (`address.city`). Array indices, expressions and reserved names are rejected. Each control accepts exactly one `nv:model` declaration.

| Modifier           | Behavior                                                                     |
| ------------------ | ---------------------------------------------------------------------------- |
| none or `.defer`   | Keep local edits until the next action; no independent request               |
| `.live`            | Synchronize input after a trailing 150ms debounce                            |
| `.blur`            | Synchronize on the control's bubbling `focusout`                             |
| `.change`, `.lazy` | Synchronize on native `change` (`.lazy` is an alias)                         |
| `.debounce[.Nms]`  | Trailing debounce (default 250ms, 1–60000ms); implies `.live` without a mode |
| `.throttle[.Nms]`  | Send immediately, suppress within the interval; no trailing call             |
| `.number`          | Complete finite decimal (exponent allowed); rejects empty, hex and partials  |
| `.boolean`         | Booleans or the strings `true`, `false`, `1`, `0`                            |

A model has at most one mode, one cast and one timer. Timing combines with `.live` but not with `.defer`, `.blur`, `.change` or `.lazy`. Duplicate, unknown, conflicting and event-only modifiers fail explicitly. The complete grammar table is in the [directive reference](directives.md#model-modifiers).

Supported controls are text-like inputs (`text`, `email`, `search`, `tel`, `url`, `password`), `number` (converted automatically), checkboxes, radios, textareas and single or multiple selects. A single checkbox produces a boolean; checkboxes modelling array state form a [checkbox group](../guides/nested-models.md#checkbox-groups); unchecked radios produce no update; [multiple selects](../guides/multiple-select.md) produce bounded unique arrays. File inputs are rejected in favour of [`nv:upload`](nv-upload.md), and `contenteditable` cannot be modelled.

An invalid local conversion reports an error and blocks the component's requests until it is corrected or the control is removed; an invalid number is never coerced to zero. IME composition does not schedule intermediate input. An ordinary action consumes pending drafts and cancels outstanding model timers. Timers are released when the control detaches, changes owner or configuration, or the client is disposed. A compatible newer local draft survives an in-flight response; native reset buttons reconcile drafts as described in [form reset](../guides/form-reset.md).

## Server contract

The field must be declared writable: `@State({ writable: true, validate })`, or `@State({ writable: ['city', 'zip'] })` to allow only some leaves of an object ([nested models](../guides/nested-models.md)). For each update the server rejects a non-writable field or leaf (`422 STATE_LOCKED`), a changed JSON kind (`422 STATE_TYPE`) and a validator that does not return `true` (`422 STATE_INVALID`) before any component code runs.

Drafts travel as `updates` with the next action. Synchronizing modifiers use `POST <endpoint>/<component>/_sync`, which the host must authorize as the policy action `$sync`; it receives the same origin, CSRF, identity, ownership, size, rate and revision checks as actions, but runs no action method, so action-method guards, pipes and interceptors do not apply. Put policies required for every write at component or global scope, or in `authorize`. Target synchronization in loading indicators with `nv:target="$sync"`.

## Security

Every writable field is client input. Validate type, length and allowlists in `validate`, and keep server-owned values (prices, roles, verification flags) non-writable. Browser constraint attributes such as `maxlength` or `type="email"` are hints, not validation. Unbound native controls never become public state merely because they have a `name`.

## Accessibility

Each modelled control needs a `<label>` (or `aria-label`). Show pending local edits with [`nv:dirty`](nv-dirty.md) and server errors with `aria-invalid` plus `aria-describedby`. Avoid `.live` on fields where a visible re-render while typing would move the caret or announce changes; the client restores the caret on retained controls, but `.blur` or `.change` is calmer for screen-reader users.

## Example

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<label for="query">Search</label>
<input id="query" nv:model.live.debounce.100ms="query" value="{{query}}" />
<span id="syncing" nv:loading="" nv:target="$sync" hidden>Syncing</span>
<p>Server search: <span id="server-query">{{query}}</span></p>
<label for="quantity">Quantity</label>
<input
  id="quantity"
  type="number"
  nv:model.blur.number="quantity"
  value="{{quantity}}"
/>
```

<!-- snippet: examples/directive-lab/src/main.ts -->

```ts
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  query = '';
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
  })
  quantity = 1;
```

The lab's `authorize` callback permits `$sync` alongside its actions.

## Verification

[Grammar and native-control readers](../../tests/client-models.test.ts), [timing scheduler](../../tests/client-model-scheduler.test.ts), [model lifecycle](../../tests/client-model-lifecycle.test.ts), [native controls](../../tests/client-native-controls.test.ts), [form reset](../../tests/client-form-reset.test.ts), [server synchronization](../../tests/live-model.test.ts), [writable paths](../../tests/live-writable-paths.test.ts), the [grammar matrix](../../tests/client-directive-grammar.test.ts) and [combination rows](../../tests/client-directive-combinations.test.ts), and the real-server [model scenarios](../../tests/browser/models.spec.ts), [multiple select](../../tests/browser/multiple-select.spec.ts) and [directive lab](../../tests/browser/directive-lab.spec.ts).
