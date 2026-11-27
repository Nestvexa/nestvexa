# nv:submit

Call one registered Live action when an owned `<form>` is submitted, instead of the native post:

```hbs
<form nv:submit='save'>
  <label for='email'>Email</label>
  <input id='email' type='email' required nv:model='email' />
  <button type='submit'>Save</button>
</form>
```

## Syntax and modifiers

The value is a registered action identifier, never an expression. `nv:submit` is only valid on a `form` element; on any other element it is a `DIRECTIVE` error. It accepts `.prevent`, `.stop`, `.self`, `.once`, the system-key filters and one `.debounce`/`.throttle` scheduler. `.window` and `.document` scopes and key filters are rejected. See [event modifiers](nv-events.md) for precedence.

Native submission of an owned Live form is always prevented, even when `.once`, throttling, a pending submit or a denied [`nv:confirm`](nv-confirm.md) suppresses the action, so an enhanced form never navigates away by accident. Native constraint validation still runs first: an invalid `required` or `type="email"` control blocks the `submit` event. While a submission is pending, a second submit of the same component is ignored. The form's fields are not serialized; values travel through [`nv:model`](nv-model.md) drafts, which the action consumes as pending `updates`.

When a component is suspended after an uncertain transport failure, a form that also has an explicit `action` attribute is handed back to the browser: the next submit is an ordinary full-page request to that host route, the interaction's first attempt rather than a resend. A form without `action` stays prevented while suspended. See the [request lifecycle](../guides/request-lifecycle.md) and [offline guide](../guides/offline.md#full-page-fallback-for-a-suspended-component).

## Server contract

The action is an `@Action()` method behind `POST <endpoint>/<component>/<action>`, explicitly permitted by the host `authorize` callback. Model fields it reads must be `@State({ writable: true, validate })`; the server rejects a non-writable field (`422 STATE_LOCKED`), a changed JSON kind (`STATE_TYPE`) or a failed validator (`STATE_INVALID`) before the method runs. Validate the complete input again in the action (for example `validateLive` from `@nestvexa/forms`) and render errors with `aria-invalid="true"` controls. Origin, CSRF, identity, revision and rate limits apply as for every action.

For a no-JavaScript equivalent, give the template real form semantics (`method="post"`, `action`, `name` attributes and a hidden `_csrf` field) and add an ordinary Nest route; [forms](../guides/forms.md#4-the-same-form-without-javascript) shows `submitForm` with post/redirect/get.

## Security

Duplicate-submit suppression is a client courtesy; the server still serializes requests by revision, and non-idempotent effects need server-side idempotency (`@Action({ idempotent: true })` or a submission ledger). Browser constraint attributes are not validation: the server validates every writable field and the action input.

## Accessibility

After an `nv:submit` response that leaves `aria-invalid="true"` controls in the submitted form, the client moves focus to the first available one, unless the user moved focus elsewhere during the request. Give each control a `<label>`, connect error text with `aria-describedby`, and use [`nv:loading.attr="disabled"`](nv-loading.md) with `nv:target` on the submit button for pending feedback.

## Example

<!-- snippet: examples/directive-lab/views/lab.hbs -->

```html
<form id="signup" nv:submit="save">
  <label for="email">Email</label>
  <input id="email" type="email" required nv:model="email" value="{{email}}" />
  <span id="email-dirty" nv:dirty="email" hidden>Unsaved email</span>
  <button id="save" type="submit" nv:loading.attr="disabled" nv:target="save">
    Save
  </button>
</form>
```

<!-- snippet: examples/directive-lab/src/main.ts -->

```ts
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  email = '';
```

<!-- snippet: examples/directive-lab/src/main.ts -->

```ts
  @Action() save(): void {
    this.saved = this.email;
    this.message = `Saved ${this.email}`;
  }
```

## Verification

[Grammar matrix](../../tests/client-directive-grammar.test.ts), [event tests](../../tests/client-events.test.ts), [Chromium/Firefox/WebKit combination rows](../../tests/client-directive-combinations.test.ts) (native submission prevented, duplicate submits while pending, nested submit buttons, implicit Enter, constraint validation, `.debounce`, denied confirmation, targeted `disabled`), [nested forms](../../tests/client-nested-forms.test.ts), [invalid-field focus](../../tests/client-form-focus.test.ts), [suspended transport](../../tests/client-transport-lifecycle.test.ts), [forms integration](../../tests/forms-live.test.ts), the real-server [directive lab](../../tests/browser/directive-lab.spec.ts) and the [resilience scenarios](../../tests/browser/runtime-resilience.spec.ts) (a suspended component's form with an `action` takes over without a resend; a healthy one keeps native submission disabled).
