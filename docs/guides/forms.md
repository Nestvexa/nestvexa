# Forms and validation

`@nestvexa/forms` validates form input on the server for two delivery modes that
share one schema: Live components (`@nestvexa/forms/live`) and ordinary HTML
form posts to Nest controller routes. This guide shows how the pieces fit; the
[package README](../../packages/forms/README.md) lists every option and default.

## 1. Pick an adapter

Every library is wrapped in the same contract:

```ts
interface SchemaAdapter<T> {
  validate(
    input: unknown,
  ): Promise<{ ok: true; value: T } | { ok: false; errors: FormErrors }>;
}
```

- `zodAdapter(schema)` — Zod 4, async refinements included. The schema is used
  structurally; `@nestvexa/forms` never imports Zod.
- `classValidatorAdapter(Dto, { groups })` — class-validator DTOs, with
  whitelisting, rejection of undecorated properties and unknown values on by
  default, and no implicit conversion.
- `customAdapter((input, issues) => value)` — hand-written rules.

Errors are keyed by stable dotted paths (`items.0.name`); `_form` holds
form-level messages. Pass `messages` to localize by `"path:code"` or `"code"`.

### Cross-field and async rules

Use the library's own tools: Zod `.refine(fn, { path: ['confirm'] })`, an async
refinement for uniqueness, or a class-validator `@Validate(Constraint)`. The
adapter runs the whole object, so cross-field rules always see every field.

## 2. Hardening happens first

Before any adapter, input is copied into plain JSON. Prototype keys
(`__proto__`, `constructor`, `prototype`), getters, class instances, `undefined`,
non-finite numbers and unsafe keys are refused; depth, key count, string length,
array length and total nodes are bounded. Nothing is coerced: `"18"` stays a
string and a repeated `name=a&name=b` stays an array for the schema to reject.
Violations throw `FormInputError`; the Live and controller helpers answer `400`.

## 3. Live components

```ts
async afterUpdate(update: LiveUpdateContext) {
  await validateField(this, adapter, fields, update.field, { metaField: 'form' });
}
@Action() async save() {
  const result = await validateLive(this, adapter, fields, { metaField: 'form' });
  if (!result.ok) return;
  await this.repository.save(result.value);
}
```

- `errors` (and the optional `form` meta) must be **read-only** `@State()`
  fields, so the browser cannot forge or clear them (`422 STATE_LOCKED`).
- Validated names must be declared `@State` fields; services are never read.
- Keep a transport bound in `@State({ writable: true, validate })` (for example
  maximum length) and the product rules in the schema.

### Validation timing

| Timing        | How                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Submit        | `nv:submit="save"` + `validateLive` in the action.                                                                   |
| Blur / change | `nv:model.blur` or `nv:model.change` + `validateField` in `afterUpdate`.                                             |
| While typing  | `nv:model.live.debounce.400ms` + `validateField`; each synchronization costs a request, mind `maxRequestsPerMinute`. |
| Explicit      | An action that calls `validateLive` without saving.                                                                  |

**Obsolete validation.** Live requests of a component are serialized by the
client and revision-checked by the server. A response always belongs to the
newest accepted state, unsynchronized edits stay in the browser's dirty drafts
during the morph, and a request built on an older revision is refused with
`409 STALE_REVISION` before hooks or validators run. There is no separate abort
protocol to manage.

**Disable only the submit request.** Put `nv:target="save"` next to
`nv:loading.attr="disabled"` on the submit button. Without it a blur
synchronization disables the button while the user is clicking it.

### Accessible errors

Expose `formView(this.errors, fields, { idPrefix, hints, visible })` and
`errorSummary(...)` as `@Computed()` values and render:

```hbs
<input id="{{fields.email.id}}" nv:model.blur="email"
  aria-invalid="{{fields.email.ariaInvalid}}"
  {{#if fields.email.describedBy}}aria-describedby="{{fields.email.describedBy}}"{{/if}} />
{{#if fields.email.invalid}}
<p id="{{fields.email.errorId}}" role="alert">{{fields.email.message}}</p>
{{/if}}
```

`visibleFields(meta, fields)` hides errors of untouched fields until the first
submit. After an `nv:submit` response that leaves `[aria-invalid="true"]`
controls in the submitted form, the client focuses the first available one —
unless the user moved focus elsewhere while the request was in flight (focus
loss to `<body>` or to the component root does not count as a move). Summary
links (`href="#profile-email"`) are plain in-page anchors.

## 4. The same form without JavaScript

Give the Live template real form semantics — `method="post"`,
`action="/profile"`, `name` attributes, `value`s and a hidden `_csrf` field —
and add an ordinary route:

```ts
@Post('profile')
@Redirect()
update(@Req() request: SessionRequest) {
  return submitForm(request, {
    form: 'profile',
    adapter: profilePostAdapter(this.users, userId),
    back: '/profile',
    allowedOrigins,
    remember: ['displayName', 'email', 'bio'],
    handle: (value) => ({ redirect: '/profile', flash: 'Profile saved.' }),
  });
}
```

With JavaScript, `nv:submit` prevents the native post. Without it the browser
posts, `submitForm` verifies the session CSRF token in constant time, validates,
stores errors and remembered input in the session and answers
`303 See Other`. The component's `mount()` reads them once with
`consumeFormState(request, 'profile')`. On success the flash message is written
to the session key that `consumeLiveFlash` reads.

Express: use `app.useBodyParser('urlencoded', { extended: false })` so bracket
keys reach `parseFormBody` and prototype keys are refused (not silently dropped
by `qs`). Fastify's default parser already yields flat keys.

### Repeated submits

- Live: the client ignores a second `nv:submit` while one is pending, and the
  server serializes requests by revision.
- No-JS: post/redirect/get prevents refresh resubmits. For non-idempotent forms
  (registration, payments), render `issueSubmissionToken(request, form)` in a
  hidden `_submission` field and pass `singleUse: ledger`. A duplicate request
  waits for the first and replays its redirect; `handle` runs once. Use a shared
  ledger (for example Redis `SET NX`) when you run several processes.

## 5. Multi-step forms, drafts and conflicts

`defineWizard` validates one step per `next` call and re-validates everything in
`finish`, so a forged `completed` list gains nothing. Keep `WizardState` in
read-only Live state or the session; read field values with `readLiveFields`.

`createDraftManager` saves drafts only with `consent: true` (record the user's
explicit opt-in yourself), bounds their size and lifetime, and keys them by a
host-resolved owner. Each save carries `expectedVersion`; when another tab saved
first the result is `{ ok: false, reason: 'conflict', current }` and nothing is
overwritten — show both versions or ask the user to reload.

Apply the same optimistic-concurrency rule to the real record: the example
profile keeps a `version`, and both the Live action and the no-JS route refuse
to save when it changed, telling the user to reload.

## 6. Authentication forms

The [auth example](../../examples/auth-forms/README.md) shows a host-owned
policy: scrypt hashes with per-user salts compared with `timingSafeEqual`, one
generic sign-in error, a dummy hash for unknown accounts, failed-attempt
throttling, session regeneration and CSRF rotation on sign-in, sign-out by POST
with CSRF. It is illustrative, not a production identity provider.

## Limits

- Live `nv:model` binds top-level fields only; Live repeaters need actions or
  child components. Nested paths work for no-JS bodies and adapters.
- File fields are not handled here.
- In-memory ledger, draft store and example throttle are single-process.
- Accessibility checks cover the example pages with axe and keyboard focus
  assertions; this is not a WCAG certification.
