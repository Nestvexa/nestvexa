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

The view data is plain text, so it works in every engine adapter as long as you
use the escaping output form. The same control in EJS, Pug and Nunjucks
(`tests/forms-view-engines.test.ts` renders one form through all four engines
and checks they produce the same elements, attributes and text):

```ejs
<input id="<%= fields.email.id %>" aria-invalid="<%= fields.email.ariaInvalid %>"
  <% if (fields.email.describedBy) { %>aria-describedby="<%= fields.email.describedBy %>"<% } %>>
<% if (fields.email.invalid) { %><p id="<%= fields.email.errorId %>" role="alert"><%= fields.email.message %></p><% } %>
```

```pug
input(id=fields.email.id aria-invalid=fields.email.ariaInvalid aria-describedby=fields.email.describedBy || undefined)
if fields.email.invalid
  p(id=fields.email.errorId role="alert")= fields.email.message
```

```njk
<input id="{{ fields.email.id }}" aria-invalid="{{ fields.email.ariaInvalid }}"
  {% if fields.email.describedBy %}aria-describedby="{{ fields.email.describedBy }}"{% endif %}>
{% if fields.email.invalid %}<p id="{{ fields.email.errorId }}" role="alert">{{ fields.email.message }}</p>{% endif %}
```

Never use the raw forms (`{{{ }}}`, `<%- %>`, Pug `!=`, Nunjucks `| safe`) for
messages, labels or values: validation messages often echo user input.

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
with CSRF. It is illustrative, not a production identity provider. For the
standard Nest stack (Passport sessions and JWT, argon2id, email verification
and password reset) see the [Passport starter](../../examples/auth-passport/README.md)
and the [databases and authentication guide](auth-and-data.md).

## 7. One form-state object

`defineForm` bundles fields, defaults, file fields, the adapter and client
hints; its snapshots are plain JSON (store them in a read-only Live `@State()`
or the session):

```ts
const profile = defineForm({
  fields: { name: '', email: '', tags: [] },
  files: { avatar: { max: 1 } },
  adapter: zodAdapter(schema),
  hints: zodHints(schema),
});
@State() form = profile.create({ email: user.email });

@Action() async save() {
  const { state, ok } = await profile.submit(this.form, async (value) => {
    const files = await finalizeFileField(profile, this.form, 'avatar', (token) =>
      this.uploads.finalize(this.request, token, { purpose: 'profile.avatar' }),
    );
    if (!files.ok) return { errors: files.errors };
    await this.users.save(value, files.files);
  });
  this.form = ok ? profile.reset(state, state.values) : state;
}
```

A snapshot holds `values`, `initial`, `errors`, `touched`, `dirty`,
`submitted`, `submitCount` and `pending`. `update`, `touch`, `reset` (to the
baseline or a new baseline), `clear` (empty values, baseline kept), `begin`
(refuses a second submit while `pending`), `finish`, `validate`, `submit` and
`view` (field views with visibility rules, summary, hints, `dirty`, `valid`)
return new frozen snapshots. Undeclared fields are refused; snapshots read back
from storage are rebuilt from declared fields only.

### File fields

A file field stores `@nestvexa/uploads` references (`''`, `nvu_...` or a comma
list, the same format as `uploadReferenceField`). `validate` checks their shape;
`finalizeFileField` finalizes each token and turns `UploadError`s into field
errors (`uploadFormErrors(error, field, messages?)`, `defaultUploadMessages`);
other errors propagate. Neither package depends on the other: upload errors are
recognized structurally. Finalization re-verifies identity, purpose, expiry
and content on the server.

## 8. Actions and Nest pipes

```ts
@ServerAction({ id: 'save', input: actionSchema(profileAdapter) })
save(@ActionInput() input: Profile) { ... }               // issues keep paths

@ServerAction({ id: 'add' })
add(@ActionInput(new FormValidationPipe(classValidatorAdapter(AddItem))) input: AddItem) { ... }

@Post() create(@Body(new FormValidationPipe(contactAdapter)) body: Contact) { ... }
```

`actionSchema(adapter)` is a `safeParseAsync`-compatible view of any adapter,
accepted by `@nestvexa/actions` as an input schema; hardening violations become
issues instead of 500s. `FormValidationPipe` throws `BadRequestException` with
`{ message: string[], errors: FormErrors }`. `@nestvexa/forms` and
`@nestvexa/actions` do not import each other.

## 9. Client validation hints

`zodHints(schema)`, `classValidatorHints(Dto, { groups })` and
`hintsFromJsonSchema(jsonSchema)` derive `required`, `minlength`/`maxlength`,
`min`/`max`/`step`, `type` (`email`, `url`, `number`) and `pattern` per field.
They are generated conservatively so the browser is never stricter than the
server: regexes with flags, alternations or inner anchors are dropped, and Zod
patterns are opt-in (`zodHints(schema, { patterns: true })`) because Zod's JSON
Schema export drops regex flags. Render them with `hintAttributes(hint)` (a
name -> value map) or `hintAttributeString(hint)` (escaped markup for a trusted
helper). Keep `novalidate` if you prefer server messages only; the server
always validates again.

## 10. Autofill and browser history

Form controls should carry `autocomplete` tokens (`name`, `email`,
`username`, `new-password`, `current-password`) so password managers can fill
them. Chromium, Firefox and WebKit dispatch `input`/`change` for autofilled
controls; the Live client records those values even for `nv:model.blur`
fields that never receive focus and sends them with the next submit. A tool
that sets values silently (no events) is only observed by native form
submission (the no-JS route). Pages are `Cache-Control: no-store` and errors,
old input and flash are read once, so Back after a successful post-redirect
shows a fresh form and never re-posts. `tests/browser/forms-history.spec.ts`
covers these flows on the auth example.

## 11. Inertia React, Vue and Svelte

The adapters plug into the official Inertia `useForm` through
`@nestvexa/inertia`: `@Precognitive(schema)` validates touched fields with a
forms adapter, `inertiaValidate(schema, body)` validates the submission with
the same adapter and throws `InertiaValidationException`, and the error bag
reaches `useForm().errors` with the same keys (`_form` for form-level errors).
File fields carry `@nestvexa/uploads` tokens uploaded through
`@nestvexa/uploads/browser` and are finalized with `finalizeFileField`. See
the [Inertia guide](./inertia.md#forms-and-uploads-with-the-official-useform)
and the `/documents` pages of `examples/inertia-{react,vue,svelte}`.

## Limits

- Live `nv:model` binds top-level fields only; Live repeaters need actions or
  child components. Nested paths work for no-JS bodies and adapters.
- File fields hold upload references; the bytes are handled by
  `@nestvexa/uploads`.
- Live does not observe values set without `input`/`change` events.
- In-memory ledger, draft store and example throttle are single-process.
- Accessibility checks cover the example pages with axe and keyboard focus
  assertions; this is not a WCAG certification.

## CLI

`nestvexa make:form <Name>` generates a Live form with a Zod schema, `validateField`/`validateLive`, an accessible view and its Live registration. See the [CLI reference](../reference/cli.md).
