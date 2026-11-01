# @nestvexa/forms

Server-authoritative form validation for NestJS and Nestvexa Live. It provides:

- one **schema adapter contract** with adapters for **Zod 4**, **class-validator /
  class-transformer** DTOs and hand-written validators;
- **input hardening** that runs before any adapter (prototype-pollution keys,
  type confusion, depth/size bounds);
- **Live integration** (`@nestvexa/forms/live`): submit-time and per-field
  validation inside a component, writing a read-only `errors` state field;
- **accessible error helpers**: per-field `aria-invalid`/`aria-describedby` data
  and an error summary; the Live client moves focus to the first invalid field
  after an `nv:submit` response;
- **form state** helpers (touched/dirty/submitted, nested paths, repeaters), a
  **multi-step wizard** and **drafts** with consent, expiry and version conflicts;
- a **no-JavaScript POST fallback** for ordinary Nest controller routes with real
  CSRF verification, `303` redirects, read-once errors/old input and flash
  messages, plus optional single-use submission tokens.

Status: `0.1.0-alpha.0`, experimental, ESM only. The server always validates;
nothing here generates client-side validation or trusts the browser.

## Install

```sh
pnpm add @nestvexa/forms
# then the optional peer(s) you use
pnpm add zod                                  # zodAdapter
pnpm add class-validator class-transformer    # classValidatorAdapter
```

`npm install` and `yarn add` work the same way.

### Peer dependencies

| Peer                                                    | Required                         | Notes                                                                                    |
| ------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `@nestjs/common` `^12`                                  | yes                              | `submitForm` throws Nest `ForbiddenException`/`BadRequestException`.                     |
| `@nestvexa/live`                                        | only for `@nestvexa/forms/live`  | Usually installed through the `nestvexa` umbrella package.                               |
| `zod` `^4`                                              | only for `zodAdapter`            | Never imported by this package: your schema instance is used structurally.               |
| `class-validator` `^0.15`, `class-transformer` `^0.5.1` | only for `classValidatorAdapter` | Loaded with a dynamic `import()` on first validation; install one copy (peer singleton). |

Importing `@nestvexa/forms` never loads Zod or class-validator. The umbrella
`nestvexa` package does not include forms; install it explicitly.

## Quick start (Live component)

```ts
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import {
  createFormMeta,
  formView,
  visibleFields,
  zodAdapter,
} from '@nestvexa/forms';
import type { FormErrors, FormMeta } from '@nestvexa/forms';
import { validateField, validateLive } from '@nestvexa/forms/live';
import { z } from 'zod';

const profile = zodAdapter(
  z.strictObject({
    name: z.string().trim().min(2, 'Enter at least 2 characters.'),
    email: z.email('Enter a valid email address.'),
  }),
);
const fields = ['name', 'email'];

@LiveComponent({ name: 'profile-form', view: 'profile-form' })
export class ProfileForm {
  @State({
    writable: true,
    validate: (v) => typeof v === 'string' && v.length <= 200,
  })
  name = '';
  @State({
    writable: true,
    validate: (v) => typeof v === 'string' && v.length <= 254,
  })
  email = '';
  @State() errors: FormErrors = {}; // read-only: the server owns the error bag
  @State() form: FormMeta = createFormMeta();

  @Computed() get view() {
    return formView(this.errors, fields, {
      idPrefix: 'profile-',
      visible: visibleFields(this.form, fields),
    });
  }
  async afterUpdate(update: LiveUpdateContext) {
    await validateField(this, profile, fields, update.field, {
      metaField: 'form',
    });
  }
  @Action() async save() {
    const result = await validateLive(this, profile, fields, {
      metaField: 'form',
    });
    if (!result.ok) return;
    // result.value is typed { name: string; email: string }
  }
}
```

```hbs
<form nv:submit="save" novalidate>
  <label for="{{view.name.id}}">Name</label>
  <input id="{{view.name.id}}" nv:model.blur="name" aria-invalid="{{view.name.ariaInvalid}}"
    {{#if view.name.describedBy}}aria-describedby="{{view.name.describedBy}}"{{/if}} />
  {{#if view.name.invalid}}<p id="{{view.name.errorId}}" role="alert">{{view.name.message}}</p>{{/if}}
  …
  <button nv:loading.attr="disabled" nv:target="save">Save</button>
</form>
```

## Quick start (no-JavaScript controller route)

```ts
@Get('contact')
@Render('contact')
page(@Req() request: Request) {
  const { errors, old } = consumeFormState(request, 'contact'); // read-once
  return { csrf: csrfToken(request), old, fields: formView(errors, ['email']) };
}

@Post('contact')
@Redirect() // submitForm returns { url, statusCode: 303 }
submit(@Req() request: Request) {
  return submitForm(request, {
    form: 'contact',
    adapter: contactAdapter,
    back: '/contact',
    allowedOrigins: ['https://app.example.com'],
    remember: ['email'],
    handle: async (value) => {
      await this.messages.send(value);
      return { redirect: '/contact/thanks', flash: 'Message sent.' };
    },
  });
}
```

Templates render `<input type="hidden" name="_csrf" value="{{csrf}}">`. With
Express, register `app.useBodyParser('urlencoded', { extended: false })` so bracket
keys reach `parseFormBody` (which refuses prototype keys loudly; `qs` drops them
silently). Fastify's default parser already produces flat keys. A session
middleware is required.

## Public API

### Adapters (`@nestvexa/forms`)

| Export                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SchemaAdapter<T>`                     | `{ validate(input): Promise<ValidationResult<T>> }`; `ValidationResult<T>` is `{ ok: true, value: T } \| { ok: false, errors: FormErrors }`. `AdapterOutput<A>` extracts `T`.                                                                                                                                                                                                                                        |
| `zodAdapter(schema, options?)`         | Hardens, then `schema.safeParseAsync` (async refinements supported). Typed by the schema output. Issue codes are localization keys. Use `z.strictObject` to reject unknown keys.                                                                                                                                                                                                                                     |
| `classValidatorAdapter(Dto, options?)` | Hardens, `plainToInstance` with `enableImplicitConversion: false`, then `validate` with `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` **on** by default. Options: `groups`, `strictGroups` (default true with groups), `skipMissingProperties` (partial validation), the three flags above, `messages`, `limits`. Returns the DTO instance. Transform exceptions become a form-level `transform` issue. |
| `customAdapter(fn, options?)`          | `fn(input, issues)` may be async; call `issues.issue(path, code, message)`; the returned value is used only when no issue was recorded.                                                                                                                                                                                                                                                                              |
| `validateForm(adapter, input, opts?)`  | Hardening plus runtime checks/bounds on any (third-party) adapter's result.                                                                                                                                                                                                                                                                                                                                          |
| `localizeIssue(issue, messages?)`      | Message lookup used by all built-in adapters.                                                                                                                                                                                                                                                                                                                                                                        |
| `MessageMap`                           | `Record<string, string>` searched for `"<path>:<code>"` then `"<code>"` (`{path}` placeholder), or a function returning a message or `undefined`.                                                                                                                                                                                                                                                                    |

### Errors and paths

`FormErrors` is `Readonly<Record<path, readonly string[]>>` with stable dotted
paths (`items.0.name`); `FORM_ERROR` (`'_form'`) holds form-level messages.
`normalizeErrors` bounds untrusted bags (100 paths, 5 messages, 500 characters;
unsafe paths fall back to `_form`). Also: `formatPath`, `parsePath`, `safeKey`,
`pathWithin`, `pickErrors`, `replaceErrors`, `hasErrors`, `firstError`,
`errorsFromIssues`.

### Hardening

`hardenInput(value, limits?)` returns a detached plain JSON copy or throws
`FormInputError` (`code`: `FORBIDDEN_KEY`, `INVALID_KEY`, `DEPTH`, `KEYS`,
`NODES`, `STRING_LENGTH`, `ARRAY_LENGTH`, `SPARSE_ARRAY`, `TYPE`, `CONFLICT`;
`path`; the message never echoes values). It refuses `__proto__`/`constructor`/
`prototype` keys, keys outside `[A-Za-z0-9_-]{1,128}`, symbol keys, accessors
(never invoked), `undefined`, functions, bigints, non-finite numbers, Dates,
Maps and class instances. Nothing is coerced. `defaultInputLimits`:
`maxDepth 8`, `maxKeys 200` (per object), `maxStringLength 10000`,
`maxArrayLength 500`, `maxNodes 5000`. `parseFormBody(body, { limits, arrays,
omit })` expands flat (`items[0][name]`, `items.0.name`, `tags[]`) or nested
urlencoded bodies; `arrays` lists multi-value fields (a lone string becomes a
one-item array, a missing one `[]`); `_csrf` and `_submission` are always omitted.

### Live integration (`@nestvexa/forms/live`)

| Export                                                      | Description                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateLive(component, adapter, fields, options?)`        | Validates the named top-level `@State` fields together, writes the error bag (`{}` on success), records a submit when `metaField` is given, returns the typed result.                                            |
| `validateField(component, adapter, fields, changed, opts?)` | Validates all `fields` (cross-field and async rules run) but replaces only the entries of `changed`; touches them in `metaField`. Returns `undefined` when `changed` is not in `fields`. Use from `afterUpdate`. |
| `readLiveFields(component, fields, limits?)`                | Hardened copy of declared, non-synthesized state fields (for wizards and drafts).                                                                                                                                |
| `LiveValidationOptions`                                     | `errorsField` (default `errors`), `metaField`, `limits`.                                                                                                                                                         |

The error and meta fields must be **read-only** `@State()` fields; validated
fields must be declared `@State` (injected services and plain members are
refused) and not use a synthesizer. Hardening violations become `400`.
Validation runs inside the serialized, revision-checked Live request, so an
obsolete validation cannot overwrite newer input; stale requests get `409`.

### View helpers

- `fieldView(errors, path, { idPrefix, hints, visible })` →
  `{ id, errorId, invalid, ariaInvalid, message, messages, describedBy }`.
- `formView(errors, paths, options)` → record of field views.
- `errorSummary(errors, { idPrefix, labels, order, title })` →
  `{ hasErrors, count, title, items: [{ path, label, message, href }] }`
  (form-level messages first, links to `#<control id>`).

### Form state, wizard and drafts

- `createFormMeta`, `touchFields`, `recordSubmit`, `visibleFields`,
  `dirtyFields`, `sameValue`; nested values: `getPath`, `setPath` (no holes, no
  prototype keys); repeaters: `insertItem` (default max 50), `removeItem`,
  `moveItem`.
- `defineWizard(steps, { final?, limits? })`: steps own disjoint top-level
  fields and an adapter. `initial`, `position`, `next` (validates the current
  step), `back`, `goTo` (only completed or first incomplete step), `reset`,
  `finish` (re-validates every step, ignoring claimed progress, then the
  optional cross-step `final` adapter). `WizardState` is JSON.
- `createDraftManager({ store, ttlMs = 7 days (≤ 30), maxBytes = 64 KiB })`:
  `load`, `save(owner, form, value, { expectedVersion, consent })`, `discard`.
  Saves require `consent: true`, are hardened and size-bounded, and are refused
  with `conflict` (returning the newer draft) when the stored version is not
  `expectedVersion`. `DraftStore.compareAndSet` must be atomic;
  `MemoryDraftStore` is process-local (bounded, oldest evicted).

### No-JS POST fallback and session helpers

- `submitForm(request, options)` → `Promise<{ url, statusCode: 303 }>`. Order:
  POST only (`400`), `allowedOrigins` + `Sec-Fetch-Site` (`403`), CSRF (`403`),
  optional single-use token, body hardening (`400`), adapter; failures store
  `{ errors, old, expiresAt }` (default 10 minutes) and redirect to `back`;
  `handle` returns `{ redirect, flash? }` or `{ errors }`. Redirect targets must
  be application-relative. Old input keeps `remember` fields, or by default
  every field except names matching
  `pass|secret|token|otp|card|cvv|cvc|ssn|confirm` — pass `remember`
  explicitly in real apps.
- `consumeFormState(request, form)` → `{ errors, old }`, read-once.
- `issueSubmissionToken(request, form)` and `MemorySubmissionLedger` /
  `SubmissionLedger`: with `singleUse`, duplicates wait up to 5 s and replay the
  first redirect without running `handle`; unknown or reused tokens return to
  the form with an "expired" message. A duplicate of an already-claimed token is
  replayed **before** CSRF verification (the first request may have regenerated
  the session on sign-in); a replay only returns the recorded redirect and
  changes nothing. Unclaimed tokens always go through every check.
- `csrfToken`, `rotateCsrfToken`, `verifyCsrf` (constant time, fails closed),
  `constantTimeEqual`, `pushFlash`/`consumeFlash` (same session key as
  `flashLive`/`consumeLiveFlash`), `sessionOf`, `safeRedirectPath`.

## Security notes

- The server is the only authority. Browser constraints (`maxlength`,
  `required`) are conveniences; Live `@State({ validate })` remains the
  transport bound and the schema the product rule.
- Hardening runs before every adapter, and again inside built-in adapters.
- CSRF is mandatory for `submitForm`; tokens are compared with
  `timingSafeEqual`. The `Origin` check is defense in depth only.
- The Live error bag is read-only state, so a client cannot forge or clear it.
- Old input never stores password-like fields by default; errors and flash
  live in the host session — use a server-side session store in production.
- Authentication, authorization and rate limiting stay host-owned. See the
  [auth example](../../examples/auth-forms/README.md) for an illustrative policy.

## Testing

```sh
pnpm build
pnpm exec vitest run tests/forms-adapters.test.ts tests/forms-hardening.test.ts tests/forms-state.test.ts tests/forms-progressive.test.ts tests/forms-live.test.ts tests/client-form-focus.test.ts
pnpm exec playwright test tests/browser/forms.spec.ts
```

## Caveats

- Live `nv:model` binds top-level fields only (a deliberate client security
  rule), so Live repeaters need actions or child components; nested paths are
  fully supported for no-JS bodies and adapters.
- Wizard and draft helpers are server primitives; the example does not ship a
  wizard UI.
- The default `MemorySubmissionLedger`, `MemoryDraftStore` and the example
  throttle are single-process.
- File inputs are out of scope (Phase 6 uploads).

See the [forms guide](../../docs/guides/forms.md) and
[ADR 0022](../../docs/adr/0022-forms-and-validation.md).
